/* ============================================================
   StudyFlow · 引导向导（#/setup）
   三步：配置 API Key → 描述学习目标 → 完成
   - 已有 Key 时第一步直接显示「已配置」，可替换
   - 创建目标成功后 refresh() 并进入完成页
   ============================================================ */
import { useState } from 'react'
import type { JSX } from 'react'
import type { AppSettings, Goal, GoalKind, GoalLevel } from '@shared/contracts'
import { Page } from '../components/layout'
import { Badge, Button, Card, ErrorState, Input, Select, TextArea, useToast } from '../components/ui'
import { call, errorMessage } from '../lib/api'
import { formatDate, formatMinutes } from '../lib/format'
import { navigate } from '../lib/router'
import { useAppStore } from '../store/app'
import './Onboarding.css'

const STEPS = [
  { key: 'key', label: '配置 API Key' },
  { key: 'goal', label: '学习目标' },
  { key: 'done', label: '完成' }
] as const

const KIND_OPTIONS: { value: GoalKind; label: string }[] = [
  { value: 'exam', label: '考试（软考 / 证书 / 升学）' },
  { value: 'skill', label: '技能（编程 / 外语 / 设计）' },
  { value: 'course', label: '课程（网课 / 教材）' },
  { value: 'project', label: '项目（作品 / 实战）' }
]

const LEVEL_OPTIONS: { value: GoalLevel; label: string }[] = [
  { value: 'zero', label: '零基础' },
  { value: 'basic', label: '有基础' },
  { value: 'some', label: '有一定经验' },
  { value: 'good', label: '比较熟' }
]

const DESCRIPTION_PLACEHOLDER = '我想 3 个月通过软考中级，能每天投入 90 分钟，目前零基础'

/** settings:testApiKey 的真实返回是 { ok, latencyMs }；message 兼容 backend 文案扩充 */
interface TestKeyResult {
  ok?: boolean
  latencyMs?: number
  message?: string
}

function kindLabel(kind: GoalKind): string {
  return KIND_OPTIONS.find((item) => item.value === kind)?.label ?? kind
}

function levelLabel(level: GoalLevel): string {
  return LEVEL_OPTIONS.find((item) => item.value === level)?.label ?? level
}

export default function Onboarding(): JSX.Element {
  const boot = useAppStore((state) => state.boot)
  const refresh = useAppStore((state) => state.refresh)
  const { success } = useToast()

  const [step, setStep] = useState(0)

  // ── 第一步：API Key ──
  const [apiKey, setApiKey] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [replaceKey, setReplaceKey] = useState(false)

  // ── 第二步：学习目标 ──
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState<GoalKind>('exam')
  const [level, setLevel] = useState<GoalLevel>('zero')
  const [dailyMinutes, setDailyMinutes] = useState('60')
  const [targetDate, setTargetDate] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  // ── 第三步：完成 ──
  const [createdGoal, setCreatedGoal] = useState<Goal | null>(null)

  const hasApiKey = boot?.settings.hasApiKey ?? false
  const showKeyForm = !hasApiKey || replaceKey
  const hasGoals = (boot?.goals.length ?? 0) > 0

  async function saveAndTestKey(): Promise<void> {
    const key = apiKey.trim()
    if (key === '') {
      setKeyError('请先粘贴 API Key')
      return
    }
    setKeyBusy(true)
    setKeyError(null)
    try {
      await call<AppSettings>('settings:setApiKey', { key })
      const result = await call<TestKeyResult>('settings:testApiKey')
      if (result.ok === false) {
        setKeyError(result.message ?? 'Key 已保存，但连通性校验未通过')
        return
      }
      const latency = typeof result.latencyMs === 'number' ? `（${result.latencyMs} ms）` : ''
      await refresh()
      setApiKey('')
      setReplaceKey(false)
      success(`API Key 验证通过${latency}`)
      setStep(1)
    } catch (err) {
      setKeyError(errorMessage(err))
    } finally {
      setKeyBusy(false)
    }
  }

  async function createGoal(): Promise<void> {
    const trimmedTitle = title.trim()
    if (trimmedTitle === '') {
      setFormError('请填写目标名称')
      return
    }
    if (trimmedTitle.length > 120) {
      setFormError('目标名称不能超过 120 字')
      return
    }
    const minutes = Number(dailyMinutes)
    if (!Number.isFinite(minutes) || minutes < 10 || minutes > 600) {
      setFormError('每日可投入分钟数需在 10–600 之间')
      return
    }

    setCreating(true)
    setFormError(null)
    try {
      const goal = await call<Goal>('goal:create', {
        title: trimmedTitle,
        description: description.trim(),
        kind,
        level,
        dailyMinutes: Math.round(minutes),
        targetDate: targetDate === '' ? null : targetDate
      })
      await refresh()
      setCreatedGoal(goal)
      setStep(2)
      success('学习目标已创建')
    } catch (err) {
      setFormError(errorMessage(err))
    } finally {
      setCreating(false)
    }
  }

  if (!boot) {
    return (
      <Page title="准备开始" subtitle="正在读取本地配置…">
        <Card>
          <p className="sf-muted">加载中…</p>
        </Card>
      </Page>
    )
  }

  return (
    <Page
      title="开始使用 StudyFlow"
      subtitle="三步准备就绪，之后由 AI 按天监督你的学习进度。"
      actions={
        hasGoals && step < 2 ? (
          <Button variant="subtle" size="sm" onClick={() => navigate('/')}>
            返回首页
          </Button>
        ) : undefined
      }
    >
      <ol className="sf-setup__steps" aria-label="向导进度">
        {STEPS.map((item, index) => {
          const state = index < step ? 'is-done' : index === step ? 'is-active' : ''
          return (
            <li
              key={item.key}
              className={`sf-setup__step ${state}`.trim()}
              aria-current={index === step ? 'step' : undefined}
            >
              <span className="sf-setup__dot" aria-hidden="true">
                {index < step ? '✓' : index + 1}
              </span>
              <span className="sf-setup__label">{item.label}</span>
            </li>
          )
        })}
      </ol>

      {step === 0 ? (
        <Card
          title="配置 DeepSeek API Key"
          subtitle="计划生成、出题与复检评分都通过 DeepSeek 完成，Key 只保存在本机。"
          actions={
            hasApiKey && !replaceKey ? <Badge tone="success" dot>已配置</Badge> : undefined
          }
          footer={
            showKeyForm ? (
              <>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setKeyError(null)
                    setStep(1)
                  }}
                >
                  稍后再说
                </Button>
                <Button onClick={() => void saveAndTestKey()} loading={keyBusy}>
                  验证并保存
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={() => setReplaceKey(true)}>
                  更换 Key
                </Button>
                <Button onClick={() => setStep(1)}>下一步</Button>
              </>
            )
          }
        >
          {showKeyForm ? (
            <div className="sf-setup__stack">
              <p className="sf-muted">
                去{' '}
                <a href="https://platform.deepseek.com" target="_blank" rel="noreferrer">
                  platform.deepseek.com
                </a>{' '}
                创建 API Key，形如 <code className="sf-mono">sk-…</code>。保存后会立刻做一次最小请求验证。
              </p>
              <Input
                label="API Key"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-xxxxxxxxxxxxxxxx"
                autoComplete="off"
                spellCheck={false}
                error={keyError ?? undefined}
                hint="验证失败也可以先跳过，之后到「设置」里补上。"
              />
            </div>
          ) : (
            <div className="sf-setup__status">
              <Badge tone="success" dot>
                已配置
              </Badge>
              <p className="sf-muted">API Key 已保存，可以直接进入下一步。</p>
            </div>
          )}
        </Card>
      ) : null}

      {step === 1 ? (
        <Card
          title="描述你的学习目标"
          subtitle="写得越具体，AI 拆出来的每日任务越贴合你的时间。"
          footer={
            <>
              <Button variant="ghost" onClick={() => setStep(0)}>
                上一步
              </Button>
              <Button onClick={() => void createGoal()} loading={creating}>
                创建目标
              </Button>
            </>
          }
        >
          <div className="sf-setup__stack">
            <Input
              label="目标名称"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如：3 个月通过软考中级"
              maxLength={120}
              autoFocus
            />
            <TextArea
              label="详细描述"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={DESCRIPTION_PLACEHOLDER}
              rows={4}
              hint="建议写清：达成时间、每天能投入多久、目前的基础。"
            />
            <div className="sf-setup__grid">
              <Select
                label="目标类型"
                value={kind}
                onChange={(event) => setKind(event.target.value as GoalKind)}
              >
                {KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
              <Select
                label="当前水平"
                value={level}
                onChange={(event) => setLevel(event.target.value as GoalLevel)}
              >
                {LEVEL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="sf-setup__grid">
              <Input
                label="每日可投入时间"
                type="number"
                min={10}
                max={600}
                step={10}
                value={dailyMinutes}
                onChange={(event) => setDailyMinutes(event.target.value)}
                suffix="分钟"
                hint="10–600 分钟"
              />
              <Input
                label="目标日期（可选）"
                type="date"
                value={targetDate}
                onChange={(event) => setTargetDate(event.target.value)}
                hint="有明确截止日期时填写"
              />
            </div>
            {formError ? <ErrorState error={undefined} message={formError} /> : null}
          </div>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card title="一切就绪" subtitle="下一步让 AI 生成一份约 30 天的学习计划。">
          <ul className="sf-setup__summary">
            <li>
              <span>目标</span>
              <strong>{createdGoal?.title ?? title}</strong>
            </li>
            <li>
              <span>类型</span>
              <strong>{kindLabel(createdGoal?.kind ?? kind)}</strong>
            </li>
            <li>
              <span>当前水平</span>
              <strong>{levelLabel(createdGoal?.level ?? level)}</strong>
            </li>
            <li>
              <span>每日投入</span>
              <strong>{formatMinutes(createdGoal?.dailyMinutes ?? (Number(dailyMinutes) || 60))}</strong>
            </li>
            {createdGoal?.targetDate ? (
              <li>
                <span>目标日期</span>
                <strong>{formatDate(createdGoal.targetDate, { withWeekday: false })}</strong>
              </li>
            ) : null}
          </ul>
          <div className="sf-setup__done-actions">
            <Button variant="ghost" onClick={() => navigate('/')}>
              稍后自己去生成
            </Button>
            <Button onClick={() => navigate('/plan/new')}>生成学习计划</Button>
          </div>
        </Card>
      ) : null}
    </Page>
  )
}
