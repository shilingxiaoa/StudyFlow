/* ============================================================
   StudyFlow · 计划生成与确认（#/plan/new）
   状态机：idle → generating → preview → saving
   - generating：真实只调一次 plan:generate，阶段文案按等待时长推进
   - idle：可先设「天数 / 每日投入」，也可就地编辑当前计划与目标
   - preview：本地删 Day / 缩减天数后重排 index，保存前至少保留一天
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type {
  GeneratedPlan,
  Goal,
  GoalInput,
  GoalKind,
  GoalLevel,
  Material,
  MaterialImportResult,
  Plan,
  PlanGenerateInput,
  PlanUpdateInput
} from '@shared/contracts'
import { Page } from '../components/layout'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  Modal,
  Select,
  Spinner,
  TextArea,
  useToast
} from '../components/ui'
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

/** 计划天数的允许区间（与主进程 plan:generate 契约一致） */
const DAYS_MIN = 1
const DAYS_MAX = 120
/** 每日投入分钟数的允许区间 */
const MINUTES_MIN = 20
const MINUTES_MAX = 600
/** 生成时的默认天数 */
const DEFAULT_DAYS = 30

const GOAL_KIND_LABEL: Record<GoalKind, string> = {
  exam: '考试',
  skill: '技能',
  course: '课程',
  project: '项目'
}

const GOAL_KIND_VALUES: GoalKind[] = ['exam', 'skill', 'course', 'project']

const GOAL_LEVEL_LABEL: Record<GoalLevel, string> = {
  zero: '零基础',
  basic: '有基础',
  some: '有一定经验',
  good: '比较熟'
}

const GOAL_LEVEL_VALUES: GoalLevel[] = ['zero', 'basic', 'some', 'good']

/** 当前计划「编辑」弹窗的表单 */
interface PlanEditForm {
  title: string
  totalDays: string
  dailyMinutes: string
}

/** 目标「编辑」弹窗的表单（数字与日期都用字符串，提交时再解析） */
interface GoalEditForm {
  title: string
  description: string
  kind: GoalKind
  level: GoalLevel
  dailyMinutes: string
  targetDate: string
}

const EMPTY_GOAL_FORM: GoalEditForm = {
  title: '',
  description: '',
  kind: 'exam',
  level: 'zero',
  dailyMinutes: '60',
  targetDate: ''
}

/** 输入框文本 → 数字；空串 / 非法值返回 null（绝不把 NaN 传给主进程） */
function parseNumber(value: string): number | null {
  const text = value.trim()
  if (text === '') return null
  const num = Number(text)
  return Number.isFinite(num) ? num : null
}

/** 输入框文本 → [min, max] 内的整数；空串 / 非法值返回 fallback */
function clampInt(value: string, min: number, max: number, fallback: number): number {
  const num = parseNumber(value)
  if (num === null) return fallback
  return Math.min(max, Math.max(min, Math.round(num)))
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
  /** 只认当前目标下的计划，避免切目标后串数据 */
  const activePlan =
    boot?.activePlan && boot.activePlan.goalId === goalId ? boot.activePlan : null
  const defaultDailyMinutes = goal?.dailyMinutes ?? 60

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

  // ── 生成前参数（idle） ──
  const [genDays, setGenDays] = useState(String(DEFAULT_DAYS))
  /** 空串表示「跟随目标的每日投入」，展示时回落到 goal.dailyMinutes */
  const [genMinutes, setGenMinutes] = useState('')
  const genMinutesValue = genMinutes === '' ? String(defaultDailyMinutes) : genMinutes

  // ── 预览态可编辑项 ──
  const [previewTitle, setPreviewTitle] = useState('')
  const [previewDaysDraft, setPreviewDaysDraft] = useState('')

  // ── 当前计划「编辑」弹窗 ──
  const [planEditOpen, setPlanEditOpen] = useState(false)
  const [planEdit, setPlanEdit] = useState<PlanEditForm>({
    title: '',
    totalDays: '',
    dailyMinutes: ''
  })
  const [planEditError, setPlanEditError] = useState<unknown>(null)
  const [planEditSaving, setPlanEditSaving] = useState(false)

  // ── 目标「编辑」弹窗 ──
  const [goalEditOpen, setGoalEditOpen] = useState(false)
  const [goalEdit, setGoalEdit] = useState<GoalEditForm>(EMPTY_GOAL_FORM)
  const [goalEditError, setGoalEditError] = useState<unknown>(null)
  const [goalEditSaving, setGoalEditSaving] = useState(false)

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
    const payload: PlanGenerateInput = {
      goalId,
      totalDays: clampInt(genDays, DAYS_MIN, DAYS_MAX, DEFAULT_DAYS),
      dailyMinutes: clampInt(genMinutesValue, MINUTES_MIN, MINUTES_MAX, defaultDailyMinutes)
    }
    try {
      const plan = await call<GeneratedPlan>('plan:generate', payload)
      if (runRef.current !== run) return
      setGenerated(reindex(plan))
      setPreviewTitle(plan.title)
      setPreviewDaysDraft(String(plan.days.length))
      setOpenDays([1])
      setPhase('preview')
      success(`已生成 ${plan.days.length} 天的计划`)
    } catch (err) {
      if (runRef.current !== run) return
      setError(err)
      setPhase('idle')
    }
  }, [goalId, genDays, genMinutesValue, defaultDailyMinutes, success])

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
    const title = previewTitle.trim() === '' ? generated.title : previewTitle.trim()
    try {
      const plan = await call<Plan>('plan:save', { goalId, plan: reindex({ ...generated, title }) })
      await refresh()
      success(`计划已创建：${plan.totalDays} 天，共 ${totals.tasks} 个任务`)
      // 生成时改过每日投入的话，回写到目标上；失败只提示，不影响跳转
      const dailyMinutes = clampInt(genMinutesValue, MINUTES_MIN, MINUTES_MAX, defaultDailyMinutes)
      if (dailyMinutes !== (goal?.dailyMinutes ?? dailyMinutes)) {
        try {
          await call<Goal>('goal:update', { goalId, dailyMinutes })
          await refresh()
        } catch (err) {
          warn(errorMessage(err))
        }
      }
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

  /**
   * 预览态「计划天数」提交：只能 ≤ 当前天数。
   * 只在失焦 / 回车时提交，避免一边输入一边把后面的 Day 删光。
   */
  function commitPreviewDays(draft: string): void {
    if (!generated) return
    const max = generated.days.length
    const parsed = parseNumber(draft)
    if (parsed === null) {
      setPreviewDaysDraft(String(max))
      return
    }
    const days = Math.min(max, Math.max(1, Math.round(parsed)))
    if (days === max) {
      setPreviewDaysDraft(String(max))
      return
    }
    setPreviewDaysDraft(String(days))
    setGenerated(reindex({ ...generated, days: generated.days.slice(0, days) }))
    setOpenDays((prev) => {
      const next = prev.filter((item) => item <= days)
      return next.length > 0 ? next : [1]
    })
    toast(`已缩减到 ${days} 天`, 'info')
  }

  function resetPreviewDaysDraft(): void {
    setPreviewDaysDraft(generated ? String(generated.days.length) : '')
  }

  // ───────── 当前计划 / 目标编辑弹窗 ─────────

  function openPlanEdit(): void {
    if (!activePlan) return
    setPlanEdit({
      title: activePlan.title,
      totalDays: String(activePlan.totalDays),
      dailyMinutes: String(defaultDailyMinutes)
    })
    setPlanEditError(null)
    setPlanEditOpen(true)
  }

  async function savePlanEdit(): Promise<void> {
    if (!activePlan || goalId === '') return
    const title = planEdit.title.trim()
    if (title === '') {
      setPlanEditError(new Error('计划标题不能为空'))
      return
    }
    const totalDays = clampInt(planEdit.totalDays, 1, activePlan.totalDays, activePlan.totalDays)
    const dailyMinutes = clampInt(planEdit.dailyMinutes, MINUTES_MIN, MINUTES_MAX, defaultDailyMinutes)
    const dailyChanged = dailyMinutes !== defaultDailyMinutes
    const input: PlanUpdateInput = { planId: activePlan.id, title }
    if (totalDays !== activePlan.totalDays) input.totalDays = totalDays

    setPlanEditSaving(true)
    setPlanEditError(null)
    try {
      await call<Plan>('plan:update', input)
      if (dailyChanged) {
        // 计划已经改成功，每日投入同步失败只提示，不回滚也不把错误挂在弹窗上
        try {
          await call<Goal>('goal:update', { goalId, dailyMinutes })
        } catch (err) {
          warn(`计划已更新，但每日投入同步失败：${errorMessage(err)}`)
        }
      }
      await useAppStore.getState().load()
      setPlanEditOpen(false)
      success('计划已更新')
    } catch (err) {
      // 后端 VALIDATION（例如「第 N 天起已经有学习记录…」）原文展示在弹窗里
      setPlanEditError(err)
    } finally {
      setPlanEditSaving(false)
    }
  }

  function openGoalEdit(): void {
    if (!goal) return
    setGoalEdit({
      title: goal.title,
      description: goal.description,
      kind: goal.kind,
      level: goal.level,
      dailyMinutes: String(goal.dailyMinutes),
      targetDate: goal.targetDate ?? ''
    })
    setGoalEditError(null)
    setGoalEditOpen(true)
  }

  async function saveGoalEdit(): Promise<void> {
    if (!goal || goalId === '') return
    const title = goalEdit.title.trim()
    if (title === '') {
      setGoalEditError(new Error('目标标题不能为空'))
      return
    }
    const dailyMinutes = clampInt(goalEdit.dailyMinutes, MINUTES_MIN, MINUTES_MAX, goal.dailyMinutes)
    const targetDate = goalEdit.targetDate.trim() === '' ? null : goalEdit.targetDate.trim()

    // 只提交真正改动过的字段
    const input: { goalId: string } & Partial<GoalInput> = { goalId }
    if (title !== goal.title) input.title = title
    if (goalEdit.description !== goal.description) input.description = goalEdit.description
    if (goalEdit.kind !== goal.kind) input.kind = goalEdit.kind
    if (goalEdit.level !== goal.level) input.level = goalEdit.level
    if (dailyMinutes !== goal.dailyMinutes) input.dailyMinutes = dailyMinutes
    if (targetDate !== goal.targetDate) input.targetDate = targetDate

    if (Object.keys(input).length <= 1) {
      setGoalEditOpen(false)
      toast('目标没有变化', 'info')
      return
    }

    setGoalEditSaving(true)
    setGoalEditError(null)
    try {
      await call<Goal>('goal:update', input)
      await useAppStore.getState().load()
      setGoalEditOpen(false)
      success('目标已更新')
    } catch (err) {
      setGoalEditError(err)
    } finally {
      setGoalEditSaving(false)
    }
  }

  // ───────── 学习资料（.md / .txt / .docx / .pptx 导入） ─────────
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
    const next = reindex({ ...generated, days })
    setGenerated(next)
    setPreviewDaysDraft(String(next.days.length))
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
          : 'AI 会按你设定的天数拆成每天 3–5 个任务。'
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
        <>
          <div className="sf-plan__toolbar">
            <span className="sf-faint">当前目标：{goal.title}</span>
            <Button variant="ghost" size="sm" onClick={openGoalEdit}>
              编辑目标
            </Button>
          </div>

          {activePlan ? (
            <Card
              title="当前计划"
              subtitle="改名与缩减天数会直接生效，已有学习记录的 Day 不会被删掉"
              actions={
                <Button variant="ghost" size="sm" onClick={openPlanEdit}>
                  编辑
                </Button>
              }
            >
              <div className="sf-plan__current">
                <div>
                  <span>计划标题</span>
                  <strong title={activePlan.title}>{activePlan.title}</strong>
                </div>
                <div>
                  <span>天数</span>
                  <strong className="sf-mono">{activePlan.totalDays} 天</strong>
                </div>
                <div>
                  <span>已通过</span>
                  <strong className="sf-mono">{activePlan.passedDays} 天</strong>
                </div>
              </div>
            </Card>
          ) : null}

          <Card
            title="学习资料（可选）"
            subtitle="导入讲义原文（.md / .txt / .docx / .pptx），份数不限，每份取前 1 万字交给 AI。"
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
                <p>支持 .md / .markdown / .txt / .docx / .pptx（课堂 PPT 会连备注一起读），一次最多 20 份，单份不超过 8MB。</p>
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

              <div className="sf-plan__params">
                <Input
                  label="计划天数"
                  type="number"
                  min={DAYS_MIN}
                  max={DAYS_MAX}
                  step={1}
                  value={genDays}
                  onChange={(event) => setGenDays(event.target.value)}
                  suffix="天"
                  hint="AI 按这个天数排，之后可以缩减"
                />
                <Input
                  label="每日投入"
                  type="number"
                  min={MINUTES_MIN}
                  max={MINUTES_MAX}
                  step={10}
                  value={genMinutesValue}
                  onChange={(event) => setGenMinutes(event.target.value)}
                  suffix="分钟"
                  hint="每天大概学多久，会和目标里的设置同步"
                />
              </div>

              <ul className="sf-plan__tips">
                <li>按你设定的天数排期，每天 3–5 个任务，难度由浅入深</li>
                <li>生成通常需要 30–60 秒，期间不会写入本地数据</li>
                <li>生成后可以逐天检查、删掉不需要的 Day、缩减天数，再保存</li>
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
        </>
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

          <Card title="计划信息" subtitle={generated.summary || '按天拆好的学习计划'}>
            {saveError !== null ? <ErrorState compact error={saveError} /> : null}
            <div className="sf-plan__params">
              <Input
                label="计划标题"
                value={previewTitle}
                onChange={(event) => setPreviewTitle(event.target.value)}
                placeholder="给这份计划起个名字"
                hint="保存后会作为计划名称"
              />
              <Input
                label="计划天数"
                type="number"
                min={1}
                max={generated.days.length}
                step={1}
                value={previewDaysDraft}
                onChange={(event) => setPreviewDaysDraft(event.target.value)}
                onBlur={(event) => commitPreviewDays(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitPreviewDays(event.currentTarget.value)
                  }
                  if (event.key === 'Escape') resetPreviewDaysDraft()
                }}
                suffix="天"
                hint="只能缩减（离开输入框后生效）；加天数请重新生成计划"
              />
            </div>
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

      <Modal
        open={planEditOpen}
        onClose={() => {
          if (!planEditSaving) setPlanEditOpen(false)
        }}
        title="编辑当前计划"
        width={520}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={planEditSaving}
              onClick={() => setPlanEditOpen(false)}
            >
              取消
            </Button>
            <Button loading={planEditSaving} onClick={() => void savePlanEdit()}>
              确定
            </Button>
          </>
        }
      >
        <div className="sf-plan__form">
          <Input
            label="计划标题"
            value={planEdit.title}
            onChange={(event) => setPlanEdit((prev) => ({ ...prev, title: event.target.value }))}
          />
          <Input
            label="计划天数"
            type="number"
            min={1}
            max={activePlan?.totalDays ?? 1}
            step={1}
            value={planEdit.totalDays}
            onChange={(event) =>
              setPlanEdit((prev) => ({ ...prev, totalDays: event.target.value }))
            }
            suffix="天"
            hint={`只能缩减（1–${activePlan?.totalDays ?? 1} 天）；要增加天数请重新生成计划`}
          />
          <Input
            label="每日投入"
            type="number"
            min={MINUTES_MIN}
            max={MINUTES_MAX}
            step={10}
            value={planEdit.dailyMinutes}
            onChange={(event) =>
              setPlanEdit((prev) => ({ ...prev, dailyMinutes: event.target.value }))
            }
            suffix="分钟"
            hint="20–600 分钟，保存后会同步到目标"
          />
          {planEditError !== null ? (
            <p className="sf-plan__form-error" role="alert">
              {errorMessage(planEditError)}
            </p>
          ) : null}
        </div>
      </Modal>

      <Modal
        open={goalEditOpen}
        onClose={() => {
          if (!goalEditSaving) setGoalEditOpen(false)
        }}
        title="编辑目标"
        width={560}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={goalEditSaving}
              onClick={() => setGoalEditOpen(false)}
            >
              取消
            </Button>
            <Button loading={goalEditSaving} onClick={() => void saveGoalEdit()}>
              确定
            </Button>
          </>
        }
      >
        <div className="sf-plan__form">
          <Input
            label="目标标题"
            value={goalEdit.title}
            onChange={(event) => setGoalEdit((prev) => ({ ...prev, title: event.target.value }))}
            hint="必填"
          />
          <TextArea
            label="目标描述"
            value={goalEdit.description}
            onChange={(event) =>
              setGoalEdit((prev) => ({ ...prev, description: event.target.value }))
            }
            rows={4}
            hint="可以写现状、截止时间、想达到的程度（可留空）"
          />
          <div className="sf-plan__params">
            <Select
              label="目标类型"
              value={goalEdit.kind}
              onChange={(event) =>
                setGoalEdit((prev) => ({ ...prev, kind: event.target.value as GoalKind }))
              }
            >
              {GOAL_KIND_VALUES.map((value) => (
                <option key={value} value={value}>
                  {GOAL_KIND_LABEL[value]}
                </option>
              ))}
            </Select>
            <Select
              label="当前水平"
              value={goalEdit.level}
              onChange={(event) =>
                setGoalEdit((prev) => ({ ...prev, level: event.target.value as GoalLevel }))
              }
            >
              {GOAL_LEVEL_VALUES.map((value) => (
                <option key={value} value={value}>
                  {GOAL_LEVEL_LABEL[value]}
                </option>
              ))}
            </Select>
          </div>
          <div className="sf-plan__params">
            <Input
              label="每日投入"
              type="number"
              min={MINUTES_MIN}
              max={MINUTES_MAX}
              step={10}
              value={goalEdit.dailyMinutes}
              onChange={(event) =>
                setGoalEdit((prev) => ({ ...prev, dailyMinutes: event.target.value }))
              }
              suffix="分钟"
              hint="20–600 分钟"
            />
            <Input
              label="目标日期（可选）"
              type="date"
              value={goalEdit.targetDate}
              onChange={(event) =>
                setGoalEdit((prev) => ({ ...prev, targetDate: event.target.value }))
              }
              hint="留空表示未设置"
            />
          </div>
          {goalEditError !== null ? (
            <p className="sf-plan__form-error" role="alert">
              {errorMessage(goalEditError)}
            </p>
          ) : null}
        </div>
      </Modal>
    </Page>
  )
}
