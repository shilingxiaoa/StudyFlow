/* ============================================================
   StudyFlow · 学习看板（#/）
   目标全景（进度环 + 30 天分段条）→ 下一步 → 三格统计 → 进度流水
   ============================================================ */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { DAY_STATUS_LABEL, IPC } from '@shared/contracts'
import type { DayStatus, ProgressEvent, ProgressSummary } from '@shared/contracts'
import { Page } from '../components/layout'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ProgressRing,
  SegmentedBar,
  Skeleton
} from '../components/ui'
import { call } from '../lib/api'
import { formatDate, formatMinutes, formatPercent, relativeTime, statusTone } from '../lib/format'
import { navigate } from '../lib/router'
import { selectBoot, useAppStore } from '../store/app'
import './Dashboard.css'

/** 进度流水的原因文案（detail 已是完整句子，这里只做短标签） */
const REASON_LABEL: Record<ProgressEvent['reason'], string> = {
  day_passed: '通过 Day 检测',
  day_partial: '部分通过 Day 检测',
  review_failed: '复检未通过',
  review_passed: '复检通过',
  manual: '手动调整'
}

/** 图例顺序：已通过 → 部分通过 → 待检测 → 学习中 → 未解锁 */
const LEGEND: DayStatus[] = ['passed', 'partial', 'exam_ready', 'learning', 'locked']

function deltaText(delta: number): string {
  if (!Number.isFinite(delta) || delta === 0) return '±0%'
  const abs = Math.abs(delta)
  const size = Number.isInteger(abs) ? String(abs) : abs.toFixed(1)
  return delta > 0 ? `+${size}%` : `-${size}%`
}

function percentText(value: number): string {
  const safe = Number.isFinite(value) ? value : 0
  return Number.isInteger(safe) ? `${safe}%` : `${safe.toFixed(1)}%`
}

function PlanArt(): JSX.Element {
  return (
    <svg viewBox="0 0 48 48" width="42" height="42" aria-hidden="true">
      <rect x="7" y="10" width="34" height="30" rx="5" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <path d="M7 19h34" stroke="currentColor" strokeWidth="2.4" />
      <path d="M16 6v7M32 6v7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M16 27h6M16 33h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}

export default function Dashboard(): JSX.Element {
  const boot = useAppStore(selectBoot)
  const goals = boot?.goals ?? []
  const plan = boot?.activePlan ?? null
  const goal = useMemo(() => {
    const goalId = plan?.goalId ?? goals[0]?.id ?? null
    return goalId ? goals.find((item) => item.id === goalId) ?? null : null
  }, [goals, plan])

  const goalId = plan?.goalId ?? goal?.id ?? null
  const goalTitle = plan?.goalTitle ?? goal?.title ?? '学习目标'
  const bootProgress = boot?.progress ?? null
  const stats = boot?.stats ?? null

  const [summary, setSummary] = useState<ProgressSummary | null>(null)
  const [summaryError, setSummaryError] = useState<unknown>(null)
  const [events, setEvents] = useState<ProgressEvent[] | null>(null)
  const [eventsError, setEventsError] = useState<unknown>(null)

  const loadSummary = useCallback(async (): Promise<void> => {
    if (!goalId) return
    setSummaryError(null)
    try {
      setSummary(await call<ProgressSummary>(IPC.PROGRESS_SUMMARY, { goalId }))
    } catch (error) {
      setSummaryError(error)
    }
  }, [goalId])

  const loadEvents = useCallback(async (): Promise<void> => {
    if (!goalId) return
    setEventsError(null)
    try {
      setEvents(await call<ProgressEvent[]>(IPC.PROGRESS_EVENTS, { goalId, limit: 12 }))
    } catch (error) {
      setEventsError(error)
    }
  }, [goalId])

  // boot 里没有 progress 时才单独拉取
  useEffect(() => {
    if (goalId && !bootProgress) void loadSummary()
  }, [goalId, bootProgress, loadSummary])

  // 进度变化（任务勾选 / 检测结算）后 boot 会刷新，percent 变了就重拉流水
  const percentMark = bootProgress?.percent ?? null
  const passedMark = bootProgress?.passedDays ?? null
  useEffect(() => {
    if (goalId) void loadEvents()
  }, [goalId, percentMark, passedMark, loadEvents])

  const progress = bootProgress ?? summary
  const segments = progress?.segments ?? []
  const totalDays = progress?.totalDays ?? plan?.totalDays ?? 0
  const percent = progress?.percent ?? goal?.progress ?? 0
  const passedDays = progress?.passedDays ?? plan?.passedDays ?? 0
  const partialDays = progress?.partialDays ?? 0
  const weekMinutes = progress?.weekMinutes ?? 0
  const dailyMinutes = goal?.dailyMinutes ?? 0
  const passRate = totalDays > 0 ? (passedDays / totalDays) * 100 : 0
  const allPassed = totalDays > 0 && passedDays >= totalDays
  const todayDay = boot?.todayDay ?? null

  const nextSegment = useMemo(
    () => segments.find((item) => item.status === 'learning' || item.status === 'exam_ready') ?? null,
    [segments]
  )

  const ctaDay = todayDay
    ? {
        id: todayDay.id,
        index: todayDay.index,
        title: todayDay.title,
        status: todayDay.status,
        done: todayDay.tasks.length > 0 && todayDay.tasks.every((task) => task.status === 'done')
      }
    : nextSegment
      ? {
          id: nextSegment.dayId,
          index: nextSegment.index,
          title: nextSegment.title,
          status: nextSegment.status,
          done: nextSegment.status === 'exam_ready'
        }
      : null

  const currentIndex = todayDay
    ? todayDay.index
    : nextSegment
      ? nextSegment.index
      : allPassed
        ? totalDays
        : Math.min(totalDays, passedDays + 1)

  if (!boot) {
    return (
      <Page width="wide">
        <Card className="dash-hero" flush>
          <div className="dash-hero__inner">
            <div className="dash-hero__main">
              <Skeleton width="120px" height={12} />
              <Skeleton width="60%" height={30} />
              <Skeleton width="40%" height={14} />
            </div>
            <Skeleton width={132} height={132} circle />
          </div>
        </Card>
        <Card>
          <Skeleton lines={3} height={16} />
        </Card>
      </Page>
    )
  }

  if (goals.length === 0) {
    return (
      <Page width="wide">
        <EmptyState
          icon={<PlanArt />}
          title="还没有学习目标"
          description="先定一个目标，StudyFlow 会把它拆成 30 天能执行的任务。"
          action={<Button onClick={() => navigate('/setup')}>创建学习目标</Button>}
        />
      </Page>
    )
  }

  return (
    <Page width="wide">
      {/* 1. 目标全景 */}
      <Card className="dash-hero" flush>
        <div className="dash-hero__inner">
          <div className="dash-hero__main">
            <p className="dash-hero__eyebrow">{plan ? '当前目标' : '学习看板'}</p>
            <h2 className="dash-hero__title">{goalTitle}</h2>
            <p className="dash-hero__meta">
              {totalDays > 0 ? `第 ${currentIndex} / ${totalDays} 天` : '计划准备中'}
              {dailyMinutes > 0 ? ` · 每天约 ${dailyMinutes} 分钟` : ''}
            </p>
            <p className="dash-hero__sub">
              {partialDays > 0
                ? `已通过 ${passedDays} 天，${partialDays} 天部分通过，可重考刷新。`
                : totalDays > 0
                  ? `已通过 ${passedDays} 天，还剩 ${Math.max(totalDays - passedDays, 0)} 天。`
                  : '还没有可执行的 Day。'}
            </p>
          </div>
          <div className="dash-hero__ring">
            <ProgressRing value={percent} size={132} stroke={9} ariaLabel={`整体进度 ${percentText(percent)}`}>
              <span className="dash-ring__value">{percentText(percent)}</span>
              <span className="dash-ring__label">已完成</span>
            </ProgressRing>
          </div>
        </div>
      </Card>

      {summaryError ? <ErrorState error={summaryError} compact onRetry={() => void loadSummary()} /> : null}

      {/* 2. 每日分段条 */}
      <Card
        className="dash-plan"
        title={totalDays > 0 ? `${totalDays} 天进度` : '学习进度'}
        subtitle={
          totalDays > 0
            ? `共 ${totalDays} 天 · 点击任意一格进入那一天`
            : undefined
        }
        actions={
          <Button variant="ghost" size="sm" onClick={() => navigate('/stats')}>
            复盘统计
          </Button>
        }
      >
        {segments.length > 0 ? (
          <div className="dash-plan__bar">
            <SegmentedBar
              segments={segments.map((item) => ({
                progress: item.progress,
                status: item.status,
                label: `Day ${item.index} ${item.title}`
              }))}
              height={12}
              gap={4}
              onSelect={(index) => {
                const target = segments[index]
                if (target) navigate(`/day/${target.dayId}`)
              }}
              ariaLabel={`${totalDays} 天进度，已通过 ${passedDays} 天`}
            />
            <ul className="dash-legend">
              {LEGEND.map((status) => (
                <li className="dash-legend__item" key={status}>
                  <i className={`dash-legend__dot dash-legend__dot--${statusTone(status)}`} aria-hidden="true" />
                  {DAY_STATUS_LABEL[status]}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <EmptyState
            title="还没有可展示的 Day"
            description="生成计划后，这里会出现每一天的格子。"
            action={plan ? undefined : <Button onClick={() => navigate('/plan/new')}>生成学习计划</Button>}
          />
        )}
      </Card>

      {/* 3. 下一步 */}
      <Card className="dash-cta" tone="accent">
        {plan === null ? (
          <div className="dash-cta__row">
            <div className="dash-cta__main">
              <p className="dash-cta__title">下一步：生成学习计划</p>
              <p className="dash-cta__hint">有了目标还没有计划，先把每天的节奏排出来。</p>
            </div>
            <Button onClick={() => navigate('/plan/new')}>生成学习计划</Button>
          </div>
        ) : allPassed ? (
          <div className="dash-cta__row">
            <div className="dash-cta__main">
              <p className="dash-cta__title">全部 {totalDays} 天通过</p>
              <p className="dash-cta__hint">这个目标已经走完一轮，去看看这段时间留下了什么。</p>
            </div>
            <Button onClick={() => navigate('/stats')}>复盘统计</Button>
          </div>
        ) : ctaDay ? (
          <div className="dash-cta__row">
            <div className="dash-cta__main">
              <p className="dash-cta__eyebrow">下一步</p>
              <p className="dash-cta__title">Day {ctaDay.index} · {ctaDay.title}</p>
              <p className="dash-cta__hint">
                {ctaDay.done
                  ? '任务已经勾完了，去跑一次检测，看看有没有讲清楚。'
                  : '接着上次没勾完的任务继续。'}
              </p>
            </div>
            <div className="dash-cta__side">
              <Badge tone={statusTone(ctaDay.status)} dot>
                {DAY_STATUS_LABEL[ctaDay.status]}
              </Badge>
              <Button onClick={() => navigate(`/day/${ctaDay.id}`)}>继续 Day {ctaDay.index}</Button>
            </div>
          </div>
        ) : (
          <div className="dash-cta__row">
            <div className="dash-cta__main">
              <p className="dash-cta__title">暂时没有可学习的 Day</p>
              <p className="dash-cta__hint">计划里的 Day 都在等待解锁，刷新一下或去复盘统计看看。</p>
            </div>
            <Button variant="ghost" onClick={() => navigate('/stats')}>
              复盘统计
            </Button>
          </div>
        )}
      </Card>

      {/* 4. 三格统计 */}
      <div className="dash-stats">
        <Card className="dash-stat" flush>
          <div className="dash-stat__inner">
            <p className="dash-stat__label">连续学习</p>
            <p className="dash-stat__value">
              {stats?.streakDays ?? 0}
              <span className="dash-stat__unit">天</span>
            </p>
            <p className="dash-stat__hint">{stats && stats.streakDays > 0 ? '今天是第几天了' : '今天学一点就算开始'}</p>
          </div>
        </Card>
        <Card className="dash-stat" flush>
          <div className="dash-stat__inner">
            <p className="dash-stat__label">本周学习</p>
            <p className="dash-stat__value">
              {weekMinutes}
              <span className="dash-stat__unit">分钟</span>
            </p>
            <p className="dash-stat__hint">{weekMinutes > 0 ? formatMinutes(weekMinutes) : '本周还没有记录'}</p>
          </div>
        </Card>
        <Card className="dash-stat" flush>
          <div className="dash-stat__inner">
            <p className="dash-stat__label">通过率</p>
            <p className="dash-stat__value">
              {formatPercent(passRate)}
            </p>
            <p className="dash-stat__hint">{totalDays > 0 ? `${passedDays} / ${totalDays} 天通过` : '还没有 Day'}</p>
          </div>
        </Card>
      </div>

      {/* 5. 最近进度 */}
      <Card
        className="dash-timeline"
        title="最近进度"
        subtitle="检测结算后记一条"
        actions={
          eventsError ? null : (
            <Button variant="ghost" size="sm" onClick={() => void loadEvents()}>
              刷新
            </Button>
          )
        }
        flush
      >
        {eventsError ? (
          <div className="dash-timeline__pad">
            <ErrorState error={eventsError} compact onRetry={() => void loadEvents()} />
          </div>
        ) : events === null ? (
          <div className="dash-timeline__pad">
            <Skeleton lines={4} height={16} />
          </div>
        ) : events.length === 0 ? (
          <div className="dash-timeline__pad">
            <EmptyState title="还没有进度记录" description="通过一次 Day 检测，这里就会记下第一步。" />
          </div>
        ) : (
          <ul className="dash-events">
            {events.map((event) => {
              const up = event.delta > 0
              const down = event.delta < 0
              return (
                <li className="dash-events__item" key={event.id}>
                  <span
                    className={`dash-events__delta ${up ? 'is-up' : down ? 'is-down' : 'is-flat'}`}
                    aria-label={`进度变化 ${deltaText(event.delta)}`}
                  >
                    {deltaText(event.delta)}
                  </span>
                  <div className="dash-events__body">
                    <p className="dash-events__reason">{REASON_LABEL[event.reason]}</p>
                    <p className="dash-events__detail">{event.detail}</p>
                  </div>
                  <time className="dash-events__time" dateTime={event.createdAt}>
                    {relativeTime(event.createdAt)}
                  </time>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {goal?.targetDate ? (
        <p className="dash-footnote">目标日期 {formatDate(goal.targetDate)}，按每天的节奏走就好。</p>
      ) : null}
    </Page>
  )
}
