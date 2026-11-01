/* ============================================================
   StudyFlow · 复盘统计（#/stats）
   - KPI 四格 + 近 14 天纯 SVG 柱状图 + 进度事件时间线 + 导出 Markdown
   ============================================================ */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { ProgressEvent, StatsOverview } from '@shared/contracts'
import { Page } from '../components/layout'
import { Badge, Button, Card, EmptyState, ErrorState, Skeleton, useToast } from '../components/ui'
import ReviewPanel from '../components/ReviewPanel'
import { call, errorMessage } from '../lib/api'
import { formatDateTime, formatMinutes, formatMoney, relativeTime } from '../lib/format'
import { Link, navigate } from '../lib/router'
import { useAppStore } from '../store/app'
import './Stats.css'

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const REASON_LABEL: Record<ProgressEvent['reason'], string> = {
  day_passed: '通过今日任务',
  day_partial: '部分完成',
  review_failed: '复检未通过',
  review_passed: '复检通过',
  manual: '手动调整'
}

/** 'YYYY-MM-DD' → 本地 Date（避免被当成 UTC 解析） */
function parseDay(iso: string): Date {
  return new Date(`${iso}T00:00:00`)
}

function todayKey(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function monthDay(iso: string): string {
  const date = parseDay(iso)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function weekdayOf(iso: string): string {
  return WEEKDAY_CN[parseDay(iso).getDay()] ?? ''
}

function niceMax(value: number): number {
  if (value <= 60) return 60
  const step = value <= 180 ? 30 : value <= 360 ? 60 : 120
  return Math.ceil(value / step) * step
}

function MinutesChart({ data }: { data: StatsOverview['dailyMinutes'] }): JSX.Element {
  const W = 720
  const H = 224
  const PAD_TOP = 16
  const PAD_RIGHT = 10
  const PAD_BOTTOM = 30
  const PAD_LEFT = 46
  const plotW = W - PAD_LEFT - PAD_RIGHT
  const plotH = H - PAD_TOP - PAD_BOTTOM
  const baseY = PAD_TOP + plotH

  const maxMinutes = data.reduce((max, item) => Math.max(max, item.minutes), 0)
  const top = niceMax(maxMinutes)
  const today = todayKey()
  const slot = data.length > 0 ? plotW / data.length : plotW
  const barWidth = Math.max(6, Math.min(26, slot * 0.5))

  const yOf = (minutes: number): number => baseY - (minutes / top) * plotH

  return (
    <svg
      className="sf-stats-chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`近 14 天学习时长柱状图，最高 ${maxMinutes} 分钟`}
    >
      <defs>
        <linearGradient id="sf-stats-chart-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--c-accent)" stopOpacity="1" />
          <stop offset="100%" stopColor="var(--c-accent)" stopOpacity="0.45" />
        </linearGradient>
      </defs>

      {[0, 0.5, 1].map((ratio) => {
        const value = Math.round(top * ratio)
        const y = yOf(value)
        return (
          <g key={ratio}>
            <line
              x1={PAD_LEFT}
              x2={W - PAD_RIGHT}
              y1={y}
              y2={y}
              className={ratio === 0 ? 'sf-stats-chart__baseline' : 'sf-stats-chart__grid'}
            />
            <text x={PAD_LEFT - 8} y={y + 3.5} textAnchor="end" className="sf-stats-chart__tick">
              {value}
            </text>
          </g>
        )
      })}

      <text x={0} y={10} className="sf-stats-chart__unit">
        分钟
      </text>

      {data.map((item, index) => {
        const x = PAD_LEFT + slot * index + (slot - barWidth) / 2
        const isToday = item.date === today
        const height = item.minutes > 0 ? Math.max(2, baseY - yOf(item.minutes)) : 0
        const showLabel = isToday || index % 3 === 0 || index === data.length - 1
        return (
          <g key={item.date} className="sf-stats-chart__group">
            <title>
              {`${monthDay(item.date)} ${weekdayOf(item.date)} · ${item.minutes} 分钟`}
            </title>
            {/* 透明命中区：没有数据的天也保留占位与 hover 提示 */}
            <rect
              x={PAD_LEFT + slot * index}
              y={PAD_TOP}
              width={slot}
              height={plotH}
              fill="transparent"
            />
            {height > 0 ? (
              <rect
                x={x}
                y={baseY - height}
                width={barWidth}
                height={height}
                rx={Math.min(4, barWidth / 2)}
                className={isToday ? 'sf-stats-chart__bar is-today' : 'sf-stats-chart__bar'}
                fill="url(#sf-stats-chart-fill)"
              />
            ) : (
              <rect
                x={x}
                y={baseY - 1}
                width={barWidth}
                height={1}
                className="sf-stats-chart__bar is-empty"
              />
            )}
            {item.minutes > 0 ? (
              <text
                x={x + barWidth / 2}
                y={baseY - height - 5}
                textAnchor="middle"
                className="sf-stats-chart__value"
              >
                {item.minutes}
              </text>
            ) : null}
            {showLabel ? (
              <text
                x={x + barWidth / 2}
                y={H - PAD_BOTTOM + 16}
                textAnchor="middle"
                className={isToday ? 'sf-stats-chart__date is-today' : 'sf-stats-chart__date'}
              >
                {isToday ? '今天' : monthDay(item.date)}
              </text>
            ) : null}
          </g>
        )
      })}
    </svg>
  )
}

export default function Stats(): JSX.Element {
  const boot = useAppStore((state) => state.boot)
  const { success, danger } = useToast()

  const goal = boot?.goals[0] ?? null
  const goalId = goal?.id ?? ''

  const [overview, setOverview] = useState<StatsOverview | null>(boot?.stats ?? null)
  const [events, setEvents] = useState<ProgressEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [exporting, setExporting] = useState(false)
  const [exportPath, setExportPath] = useState<string>('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const [nextOverview, nextEvents] = await Promise.all([
        call<StatsOverview>('stats:overview', {}),
        goalId === ''
          ? Promise.resolve<ProgressEvent[]>([])
          : call<ProgressEvent[]>('progress:events', { goalId, limit: 50 })
      ])
      setOverview(nextOverview)
      setEvents(nextEvents)
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [goalId])

  useEffect(() => {
    void load()
  }, [load])

  const chartData = useMemo(() => overview?.dailyMinutes ?? [], [overview])

  const chartSummary = useMemo(() => {
    const total = chartData.reduce((sum, item) => sum + item.minutes, 0)
    const activeDays = chartData.filter((item) => item.minutes > 0).length
    return {
      total,
      activeDays,
      avg: chartData.length > 0 ? Math.round(total / chartData.length) : 0
    }
  }, [chartData])

  async function exportReport(): Promise<void> {
    if (goalId === '') {
      danger('还没有学习目标，无法导出报告')
      return
    }
    setExporting(true)
    try {
      const result = await call<{ path: string }>('export:markdown', { goalId })
      setExportPath(result.path)
      success(`报告已导出：${result.path}`)
    } catch (err) {
      danger(errorMessage(err))
    } finally {
      setExporting(false)
    }
  }

  if (!goal) {
    return (
      <Page title="复盘统计">
        <Card>
          <EmptyState
            title="还没有学习目标"
            description="先设置目标并生成计划，这里才会出现学习记录。"
            action={<Button onClick={() => navigate('/setup')}>去设置目标</Button>}
          />
        </Card>
      </Page>
    )
  }

  const kpiLoading = overview === null
  const initialError = error !== null && overview === null

  return (
    <Page
      title="复盘统计"
      subtitle={goal.title}
      actions={
        <Button variant="ghost" size="sm" loading={loading} onClick={() => void load()}>
          刷新数据
        </Button>
      }
    >
      {initialError ? (
        <Card>
          <ErrorState error={error} onRetry={() => void load()} />
        </Card>
      ) : (
        <>
          <div className="sf-stats-kpi-grid">
            <div className="sf-stats-kpi">
              <span className="sf-stats-kpi__label">总目标数</span>
              {kpiLoading ? (
                <Skeleton width={48} height={28} />
              ) : (
                <strong className="sf-stats-kpi__value sf-mono">{overview?.totalGoals ?? 0}</strong>
              )}
              <span className="sf-stats-kpi__hint">进行中 {overview?.activeGoals ?? 0} 个</span>
            </div>
            <div className="sf-stats-kpi">
              <span className="sf-stats-kpi__label">累计通过 Day</span>
              {kpiLoading ? (
                <Skeleton width={48} height={28} />
              ) : (
                <strong className="sf-stats-kpi__value sf-mono">{overview?.totalDaysPassed ?? 0}</strong>
              )}
              <span className="sf-stats-kpi__hint">连续 {overview?.streakDays ?? 0} 天</span>
            </div>
            <div className="sf-stats-kpi">
              <span className="sf-stats-kpi__label">累计学习时长</span>
              {kpiLoading ? (
                <Skeleton width={96} height={28} />
              ) : (
                <strong className="sf-stats-kpi__value">{formatMinutes(overview?.totalMinutes ?? 0)}</strong>
              )}
              <span className="sf-stats-kpi__hint">来自已完成的任务</span>
            </div>
            <div className="sf-stats-kpi">
              <span className="sf-stats-kpi__label">本月 AI 成本</span>
              {kpiLoading ? (
                <Skeleton width={72} height={28} />
              ) : (
                <strong className="sf-stats-kpi__value sf-mono">{formatMoney(overview?.monthCost ?? 0)}</strong>
              )}
              <span className="sf-stats-kpi__hint">本月 DeepSeek 调用</span>
            </div>
          </div>

          <Card
            title="近 14 天学习时长"
            subtitle={
              chartSummary.total > 0
                ? `共 ${formatMinutes(chartSummary.total)} · 日均 ${formatMinutes(chartSummary.avg)} · ${chartSummary.activeDays} 天有记录`
                : '还没有学习记录，完成任务后会记在这里'
            }
            actions={<Badge tone="accent" size="sm">14 天</Badge>}
          >
            {chartData.length === 0 ? (
              <div className="sf-stats-skeleton">
                <Skeleton lines={4} height={18} />
              </div>
            ) : (
              <>
                <MinutesChart data={chartData} />
                <div className="sf-stats-chart__legend">
                  <span className="sf-stats-chart__legend-item">
                    <i className="sf-stats-chart__dot" />
                    每日学习分钟
                  </span>
                  <span className="sf-stats-chart__legend-item">
                    <i className="sf-stats-chart__dot is-today" />
                    今天
                  </span>
                  <span className="sf-faint">空柱表示当天没有学习记录</span>
                </div>
              </>
            )}
          </Card>

          <Card
            title="进度事件"
            subtitle={events.length > 0 ? `最近 ${events.length} 条记录` : '完成或复检任务后会生成记录'}
          >
            {loading && events.length === 0 ? (
              <div className="sf-stats-skeleton">
                <Skeleton lines={6} height={16} />
              </div>
            ) : events.length === 0 ? (
              <EmptyState
                title="还没有进度事件"
                description="打开今日计划完成任务，这里会记录每一次加分和扣分。"
                action={<Button variant="ghost" onClick={() => navigate('/')}>去今日计划</Button>}
              />
            ) : (
              <ul className="sf-stats-timeline">
                {events.map((event) => {
                  const positive = event.delta > 0
                  const negative = event.delta < 0
                  return (
                    <li
                      key={event.id}
                      className={
                        positive ? 'sf-stats-timeline__item is-plus' : negative ? 'sf-stats-timeline__item is-minus' : 'sf-stats-timeline__item'
                      }
                    >
                      <span className="sf-stats-timeline__dot" aria-hidden="true" />
                      <div className="sf-stats-timeline__body">
                        <div className="sf-stats-timeline__head">
                          <strong
                            className={
                              positive
                                ? 'sf-stats-timeline__delta is-plus sf-mono'
                                : negative
                                  ? 'sf-stats-timeline__delta is-minus sf-mono'
                                  : 'sf-stats-timeline__delta sf-mono'
                            }
                          >
                            {positive ? `+${event.delta}` : String(event.delta)}
                          </strong>
                          <span className="sf-stats-timeline__reason">{REASON_LABEL[event.reason]}</span>
                          {event.dayId ? (
                            <Link to={`/day/${event.dayId}`} className="sf-stats-timeline__link">
                              查看当天
                            </Link>
                          ) : null}
                          <time
                            className="sf-stats-timeline__time sf-faint"
                            dateTime={event.createdAt}
                            title={formatDateTime(event.createdAt, true)}
                          >
                            {relativeTime(event.createdAt)}
                          </time>
                        </div>
                        {event.detail ? <p className="sf-stats-timeline__detail">{event.detail}</p> : null}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
            {error !== null && overview !== null ? (
              <ErrorState compact error={error} onRetry={() => void load()} />
            ) : null}
          </Card>

          <ReviewPanel goalId={goalId} onDone={() => void load()} />

          <Card title="导出报告" subtitle="把目标进度和事件记录整理成一份 Markdown 文件。">
            <div className="sf-stats-export">
              <div className="sf-stats-export__info">
                <p className="sf-muted">内容包含目标概览、每日通过情况与最近事件，适合存档或发给导师。</p>
                {exportPath !== '' ? (
                  <p className="sf-faint sf-mono sf-ellipsis" title={exportPath}>
                    {exportPath}
                  </p>
                ) : null}
              </div>
              <Button loading={exporting} onClick={() => void exportReport()}>
                导出 Markdown 报告
              </Button>
            </div>
          </Card>
        </>
      )}
    </Page>
  )
}
