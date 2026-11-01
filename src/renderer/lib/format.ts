/**
 * 展示层格式化 —— 全站唯一的时间/数字文案出口。
 * 原则：中文优先、空值统一显示 `—`、不抛异常。
 */
import dayjs from 'dayjs'
import type { DayStatus, TaskKind, TaskStatus } from '@shared/contracts'
import { DAY_STATUS_LABEL } from '@shared/contracts'

/** 语义色（与 styles/tokens.css 的 --c-* 对应，ui.tsx 的 Badge/Toast 共用） */
export type Tone = 'neutral' | 'accent' | 'info' | 'success' | 'warn' | 'danger'

export type DateInput = string | number | Date | dayjs.Dayjs | null | undefined

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

/** 统一的空值占位 */
export const EMPTY = '—'

function toDayjs(input: DateInput): dayjs.Dayjs | null {
  if (input === null || input === undefined || input === '') return null
  const parsed = dayjs(input)
  return parsed.isValid() ? parsed : null
}

/** 90 → "1 小时 30 分钟"；45 → "45 分钟"；空值 → "—" */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return EMPTY
  const total = Math.max(0, Math.round(minutes))
  if (total < 60) return `${total} 分钟`
  const hours = Math.floor(total / 60)
  const rest = total % 60
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`
}

/**
 * 日期。默认输出 `10月20日 周一`；跨年或 withYear 时补年份。
 * 供 day 头部、列表、设置页共用。
 */
export function formatDate(
  input: DateInput,
  opts: { withYear?: boolean; withWeekday?: boolean } = {}
): string {
  const d = toDayjs(input)
  if (!d) return EMPTY
  const withYear = opts.withYear ?? d.year() !== dayjs().year()
  const withWeekday = opts.withWeekday ?? true
  const base = withYear
    ? `${d.year()}年${d.month() + 1}月${d.date()}日`
    : `${d.month() + 1}月${d.date()}日`
  return withWeekday ? `${base} ${WEEKDAYS[d.day()]}` : base
}

/** 日期 + 时刻：`10月20日 周一 14:30` */
export function formatDateTime(input: DateInput, withYear = false): string {
  const d = toDayjs(input)
  if (!d) return EMPTY
  const time = `${String(d.hour()).padStart(2, '0')}:${String(d.minute()).padStart(2, '0')}`
  return `${formatDate(d, { withYear, withWeekday: true })} ${time}`
}

/** 百分比：73.4 → "73%"；非数字 → "—"（超出 0–100 会夹取，避免出现 120%） */
export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY
  const clamped = Math.min(100, Math.max(0, value))
  const fixed = clamped.toFixed(Math.max(0, Math.min(4, Math.trunc(digits))))
  // 去掉 "73.0%" 里没意义的尾零
  const text = digits > 0 ? fixed.replace(/\.?0+$/, '') : fixed
  return `${text}%`
}

/** 相对时间：刚刚 / 12 分钟前 / 3 小时前 / 昨天 / 4 天前 / 10月2日 */
export function relativeTime(input: DateInput): string {
  const d = toDayjs(input)
  if (!d) return EMPTY

  const now = dayjs()
  const diffSeconds = now.diff(d, 'second')

  if (diffSeconds < 0) {
    // 未来时间（例如提醒时刻）
    const aheadMinutes = Math.abs(diffSeconds) / 60
    if (aheadMinutes < 1) return '马上'
    if (aheadMinutes < 60) return `${Math.ceil(aheadMinutes)} 分钟后`
    if (aheadMinutes < 60 * 24) return `${Math.ceil(aheadMinutes / 60)} 小时后`
    return formatDate(d, { withWeekday: false })
  }

  if (diffSeconds < 45) return '刚刚'
  if (diffSeconds < 3600) return `${Math.max(1, Math.floor(diffSeconds / 60))} 分钟前`
  if (diffSeconds < 60 * 60 * 24) return `${Math.floor(diffSeconds / 3600)} 小时前`

  const dayDiff = now.startOf('day').diff(d.startOf('day'), 'day')
  if (dayDiff <= 1) return '昨天'
  if (dayDiff < 7) return `${dayDiff} 天前`
  return formatDate(d, { withWeekday: false })
}

/** day 状态中文（直接取契约里的 DAY_STATUS_LABEL） */
export function statusLabel(status: DayStatus): string {
  return DAY_STATUS_LABEL[status] ?? String(status)
}

/** day 状态 → 语义色，保证日历/列表/徽标同色 */
export function statusTone(status: DayStatus): Tone {
  switch (status) {
    case 'passed':
      return 'success'
    case 'failed':
      return 'danger'
    case 'partial':
    case 'exam_ready':
      return 'warn'
    case 'learning':
      return 'accent'
    case 'locked':
    default:
      return 'neutral'
  }
}

/** 任务状态中文 */
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '待开始',
  doing: '进行中',
  done: '已完成',
  skipped: '已跳过'
}

/** 任务类型中文 */
export const TASK_KIND_LABEL: Record<TaskKind, string> = {
  read: '阅读',
  watch: '观看',
  practice: '练习',
  write: '写作',
  review: '复习',
  other: '其他'
}

/** 金额：12.3 → "¥12.30"（统计页 AI 成本） */
export function formatMoney(yuan: number | null | undefined): string {
  if (yuan === null || yuan === undefined || !Number.isFinite(yuan)) return EMPTY
  return `¥${yuan.toFixed(2)}`
}

/** 分数：83, 100 → "83 / 100"；null → "—" */
export function formatScore(score: number | null | undefined, total = 100): string {
  if (score === null || score === undefined || !Number.isFinite(score)) return EMPTY
  return `${Math.round(score)} / ${total}`
}
