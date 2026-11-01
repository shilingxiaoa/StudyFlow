/* ============================================================
   StudyFlow · 计划生成与确认（#/plan/new）
   状态机：idle → generating → preview → saving
   - generating：真实只调一次 plan:generate，阶段文案按等待时长推进
   - preview：本地删除 Day 后重排 index，保存前至少保留一天
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { GeneratedPlan, GoalKind, Material, MaterialImportResult, Plan } from '@shared/contracts'
import { Page } from '../components/layout'
import { Badge, Button, Card, EmptyState, ErrorState, Spinner, useToast } from '../components/ui'
import { call, errorMessage } from '../lib/api'
import { TASK_KIND_LABEL, formatDate, formatMinutes, formatPercent } from '../lib/format'
import { navigate } from '../lib/router'
import { useAppStore } from '../store/app'
import './PlanNew.css'

type Phase = 'idle' | 'generating' | 'preview' | 'saving'

const PHASES = ['正在拆解目标…', '正在按难度排期…', '正在生成每日任务…']
/** 超过这个时间没有任何返回就提示重试（IPC 本身没有超时） */
const TIMEOUT_MS = 180_000
/** 阶段文案每隔这么多秒往前走一格 */
const PHASE_STEP_SECONDS = 8

const GOAL_KIND_LABEL: Record<GoalKind, string> = {
  exam: '考试',
  skill: '技能',
  course: '课程',
  project: '项目'
}

/** 删除某天后重排：index 连续、totalDays 跟着变 */
function reindex(plan: GeneratedPlan): GeneratedPlan {
  return {
    ...plan,
    totalDays: plan.days.length,
    days: plan.days.map((day, index) => ({ ...day, index: index + 1 }))
  }
}

function IconSpark(): JSX.Element {
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" fill="none" aria-hidden="true">
      <path
        d="M17 4.5l2.9 7.6 7.6 2.9-7.6 2.9L17 25.5l-2.9-7.6L6.5 15l7.6-2.9L17 4.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M25.5 23.5l1.3 3.2 3.2 1.3-3.2 1.3-1.3 3.2-1.3-3.2-3.2-1.3 3.2-1.3 1.3-3.2Z" fill="currentColor" opacity=".5" />
    </svg>
  )
}

export default function PlanNew(): JSX.Element {
  const boot = useAppStore((state) => state.boot)
  const refresh = useAppStore((state) => state.refresh)
  const { success, warn, toast } = useToast()

  const activeGoalId = boot?.activeGoalId ?? null
  const goal = boot?.goals.find((item) => item.id === activeGoalId) ?? null
  const goalId = goal?.id ?? ''
  const planCount = boot?.plans.length ?? 0

  const [phase, setPhase] = useState<Phase>('idle')
  const [generated, setGenerated] = useState<GeneratedPlan | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [saveError, setSaveError] = useState<unknown>(null)
  const [elapsed, setElapsed] = useState(0)
  const [openDays, setOpenDays] = useState<number[]>([1])
  const [materials, setMaterials] = useState<Material[]>([])
  const [importing, setImporting] = useState(false)
  /** 每次生成自增；超时/重试后旧请求的结果直接丢弃 */
  const runRef = useRef(0)

  const totals = useMemo(() => {
    const days = generated?.days ?? []
    const tasks = days.reduce((sum, day) => sum + day.tasks.length, 0)
    const minutes = days.reduce(
      (sum, day) => sum + day.tasks.reduce((inner, task) => inner + task.estMinutes, 0),
      0
    )
    return {
      days: days.length,
      tasks,
      minutes,
      avg: days.length > 0 ? Math.round(minutes / days.length) : 0
    }
  }, [generated])

  const generatePlan = useCallback(async (): Promise<void> => {
    if (goalId === '') return
    const run = runRef.current + 1
    runRef.current = run
    setPhase('generating')
    setError(null)
    setSaveError(null)
    setGenerated(null)
    setElapsed(0)
    try {
      const plan = await call<GeneratedPlan>('plan:generate', { goalId })
      if (runRef.current !== run) return
      setGenerated(reindex(plan))
      setOpenDays([1])
      setPhase('preview')
      success(`已生成 ${plan.days.length} 天的计划`)
    } catch (err) {
      if (runRef.current !== run) return
      setError(err)
      setPhase('idle')
    }
  }, [goalId, success])

  // 生成中：计时器（驱动「已等待 N 秒」与阶段文案）
  useEffect(() => {
    if (phase !== 'generating') return undefined
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [phase])

  // 生成中：超时兜底（旧结果会被 runRef 作废）
  useEffect(() => {
    if (phase !== 'generating') return undefined
    const timer = window.setTimeout(() => {
      runRef.current += 1
      setError(new Error('生成超过 3 分钟仍未返回，请检查网络后重试'))
      setPhase('idle')
      warn('生成超时，已停止等待')
    }, TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [phase, warn])

  async function savePlan(): Promise<void> {
    if (!generated || goalId === '') return
    if (generated.days.length === 0) {
      warn('至少要保留一天才能保存')
      return
    }
    setPhase('saving')
    setSaveError(null)
    try {
      const plan = await call<Plan>('plan:save', { goalId, plan: generated })
      await refresh()
      success(`计划已创建：${plan.totalDays} 天，共 ${totals.tasks} 个任务`)
      navigate('/')
    } catch (err) {
      setSaveError(err)
      setPhase('preview')
      warn(errorMessage(err))
    }
  }

  function toggleDay(index: number): void {
    setOpenDays((prev) =>
      prev.includes(index) ? prev.filter((item) => item !== index) : [...prev, index]
    )
  }

  // ───────── 学习资料（.md / .txt / .docx 导入） ─────────
  const loadMaterials = useCallback(async (): Promise<void> => {
    if (goalId === '') return
    try {
      const list = await call<Material[]>('material:list', { goalId })
      setMaterials(list)
    } catch {
      // 资料只是加分项，读失败不打断主流程
    }
  }, [goalId])

  useEffect(() => {
    void loadMaterials()
  }, [loadMaterials])

  async function importMaterials(): Promise<void> {
    if (goalId === '') return
    setImporting(true)
    try {
      const result = await call<MaterialImportResult>('material:import', { goalId })
      setMaterials(result.materials)
      if (result.imported > 0) {
        success(
          result.skipped.length > 0
            ? `已导入 ${result.imported} 份，跳过 ${result.skipped.length} 份`
            : `已导入 ${result.imported} 份资料`
        )
      }
      if (result.skipped.length > 0) {
        warn(result.skipped.map((item) => `${item.name}：${item.reason}`).join('；'))
      }
    } catch (err) {
      warn(errorMessage(err))
    } finally {
      setImporting(false)
    }
  }

  async function removeMaterial(materialId: string): Promise<void> {
    try {
      await call<{ id: string }>('material:delete', { materialId })
      setMaterials((prev) => prev.filter((item) => item.id !== materialId))
    } catch (err) {
      warn(errorMessage(err))
    }
  }

  function removeDay(target: number): void {
    if (!generated) return
    const days = generated.days.filter((day) => day.index !== target)
    if (days.length === 0) {
      warn('至少要保留一天才能保存')
      return
    }
    setGenerated(reindex({ ...generated, days }))
    setOpenDays((prev) =>
      prev.filter((item) => item !== target).map((item) => (item > target ? item - 1 : item))
    )
    toast(`已移除 Day ${target}，保存前可以重新生成`, 'info')
  }

  if (!goal) {
    return (
      <Page title="新建学习计划">
        <Card>
          <EmptyState
            icon={<IconSpark />}
            title="还没有学习目标"
            description="先描述你要达成的目标，AI 才能按天拆出计划。"
            action={<Button onClick={() => navigate('/setup')}>去设置目标</Button>}
          />
        </Card>
      </Page>
    )
  }

  const phaseIndex = Math.min(PHASES.length - 1, Math.floor(elapsed / PHASE_STEP_SECONDS))
  const generatingPercent = Math.min(94, Math.round(8 + elapsed * 1.4))
  const showPreview = generated !== null && (phase === 'preview' || phase === 'saving')

  return (
    <Page
      title={showPreview ? '确认学习计划' : '新建学习计划'}
      subtitle={
        showPreview && generated
          ? `共 ${totals.days} 天 · ${totals.tasks} 个任务 · ${formatMinutes(totals.minutes)}`
          : 'AI 会按目标拆成约 30 天，每天 3–5 个任务。'
      }
      width="wide"
      actions={
        showPreview ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={phase === 'saving'}
              onClick={() => void generatePlan()}
            >
              重新生成
            </Button>
            <Button size="sm" loading={phase === 'saving'} onClick={() => void savePlan()}>
              保存计划
            </Button>
          </>
        ) : undefined
      }
    >
      {phase === 'generating' ? (
        <Card title="正在生成学习计划" subtitle={`目标：${goal.title}`}>
          <div className="sf-plan__gen">
            <div className="sf-plan__gen-head">
              <Spinner size={26} label="生成中" />
              <div className="sf-plan__gen-text">
                <p key={phaseIndex} className="sf-plan__phase">
                  {PHASES[phaseIndex]}
                </p>
                <p className="sf-muted">已等待 {elapsed} 秒 · 通常需要 30–60 秒</p>
              </div>
            </div>
            <div
              className="sf-plan__bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={generatingPercent}
              aria-label="生成进度"
            >
              <span className="sf-plan__bar-fill" style={{ width: `${generatingPercent}%` }} />
            </div>
            <p className="sf-faint">生成期间请保持窗口打开；超过 3 分钟无响应会提示重试。</p>
          </div>
        </Card>
      ) : null}

      {phase === 'idle' ? (
        <Card
          title="学习资料（可选）"
          subtitle="导入教材 / 笔记原文，生成计划时 AI 会参考（最多 3 份、每份前 5000 字）。"
          actions={
            <Button
              variant={materials.length === 0 ? 'primary' : 'ghost'}
              size="sm"
              loading={importing}
              onClick={() => void importMaterials()}
            >
              {materials.length === 0 ? '导入文件' : '继续导入'}
            </Button>
          }
        >
          {materials.length === 0 ? (
            <div className="sf-plan__mats-empty">
              <p>支持 .md / .markdown / .txt / .docx，一次最多 20 份，单份不超过 8MB。</p>
              <p className="sf-faint">不导入也能生成：没有资料时 AI 按目标本身的常识拆解。</p>
            </div>
          ) : (
            <ul className="sf-plan__mats">
              {materials.map((material) => (
                <li key={material.id} className="sf-plan__mat">
                  <div className="sf-plan__mat-main">
                    <span className="sf-plan__mat-name" title={material.title}>
                      {material.title}
                    </span>
                    <span className="sf-plan__mat-meta">
                      {material.kind === 'chapter' ? '文档' : material.kind === 'link' ? '链接' : '文本'}
                      {' · '}
                      {material.content.length.toLocaleString('zh-CN')} 字
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={importing}
                    onClick={() => void removeMaterial(material.id)}
                  >
                    移除
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {phase === 'idle' ? (
        <Card title="生成学习计划" subtitle={`目标：${goal.title}`} actions={<Badge tone="accent">{GOAL_KIND_LABEL[goal.kind]}</Badge>}>
          <div className="sf-plan__intro">
            <div className="sf-plan__facts">
              <div>
                <span>目标类型</span>
                <strong>{GOAL_KIND_LABEL[goal.kind]}</strong>
              </div>
              <div>
                <span>每日投入</span>
                <strong>{formatMinutes(goal.dailyMinutes)}</strong>
              </div>
              <div>
                <span>目标日期</span>
                <strong>
                  {goal.targetDate ? formatDate(goal.targetDate, { withWeekday: false }) : '未设置'}
                </strong>
              </div>
              <div>
                <span>当前进度</span>
                <strong className="sf-mono">{formatPercent(goal.progress)}</strong>
              </div>
            </div>
            <ul className="sf-plan__tips">
              <li>覆盖约 30 天，每天 3–5 个任务，按难度由浅入深排期</li>
              <li>生成通常需要 30–60 秒，期间不会写入本地数据</li>
              <li>生成后可以逐天检查、删掉不需要的 Day，再保存</li>
              {planCount > 0 ? (
                <li>
                  这个目标已有 {planCount} 份计划：保存新计划后旧计划会归档，历史数据与统计都会保留
                </li>
              ) : null}
            </ul>
            {error !== null ? (
              <ErrorState error={error} onRetry={() => void generatePlan()} retryText="重新生成" />
            ) : null}
          </div>
          <div className="sf-plan__start">
            <Button size="lg" onClick={() => void generatePlan()}>
              生成学习计划
            </Button>
          </div>
        </Card>
      ) : null}

      {showPreview && generated ? (
        <>
          <div className="sf-plan__stats">
            <div className="sf-plan__stat">
              <span>总天数</span>
              <strong className="sf-mono">{totals.days}</strong>
            </div>
            <div className="sf-plan__stat">
              <span>总任务数</span>
              <strong className="sf-mono">{totals.tasks}</strong>
            </div>
            <div className="sf-plan__stat">
              <span>平均每天</span>
              <strong className="sf-mono">{formatMinutes(totals.avg)}</strong>
            </div>
            <div className="sf-plan__stat">
              <span>总时长</span>
              <strong className="sf-mono">{formatMinutes(totals.minutes)}</strong>
            </div>
          </div>

          <Card title={generated.title} subtitle={generated.summary || '按天拆好的学习计划'}>
            {saveError !== null ? <ErrorState compact error={saveError} /> : null}
            <p className="sf-faint">点开任意一天可以检查任务；不需要的 Day 可以直接删除，保存时会被跳过。</p>
          </Card>

          <div className="sf-plan__days">
            {generated.days.map((day) => {
              const open = openDays.includes(day.index)
              return (
                <article key={day.index} className={open ? 'sf-plan-day is-open' : 'sf-plan-day'}>
                  <button
                    type="button"
                    className="sf-plan-day__head"
                    onClick={() => toggleDay(day.index)}
                    aria-expanded={open}
                  >
                    <span className="sf-plan-day__index">Day {day.index}</span>
                    <span className="sf-plan-day__title">{day.title}</span>
                    <span className="sf-plan-day__meta">
                      {day.tasks.length} 个任务 · {formatMinutes(day.estMinutes)}
                    </span>
                    <span className="sf-plan-day__chevron" aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path
                          d="M3.5 5.5 7 9l3.5-3.5"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                  </button>
                  {open ? (
                    <div className="sf-plan-day__body">
                      {day.goal ? <p className="sf-plan-day__goal">{day.goal}</p> : null}
                      {day.checkpoints.length > 0 ? (
                        <ul className="sf-plan-day__checkpoints">
                          {day.checkpoints.map((checkpoint, index) => (
                            <li key={`${day.index}-cp-${index}`}>{checkpoint}</li>
                          ))}
                        </ul>
                      ) : null}
                      {day.tasks.length > 0 ? (
                        <ul className="sf-plan-day__tasks">
                          {day.tasks.map((task, index) => (
                            <li key={`${day.index}-task-${index}`} className="sf-plan-day__task">
                              <Badge tone="neutral" size="sm">
                                {TASK_KIND_LABEL[task.kind]}
                              </Badge>
                              <span className="sf-plan-day__task-title">{task.title}</span>
                              <span className="sf-plan-day__task-minutes sf-mono">{task.estMinutes}′</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="sf-faint">这一天没有任务，可以删除。</p>
                      )}
                      <div className="sf-plan-day__actions">
                        <Button variant="ghost" size="sm" onClick={() => removeDay(day.index)}>
                          删除这一天
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </article>
              )
            })}
          </div>

          <div className="sf-plan__save">
            <p className="sf-faint">保存后旧计划会归档，新计划从 Day 1 开始学习。</p>
            <Button loading={phase === 'saving'} onClick={() => void savePlan()}>
              保存计划（{totals.days} 天）
            </Button>
          </div>
        </>
      ) : null}
    </Page>
  )
}
