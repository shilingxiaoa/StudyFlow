/* ============================================================
   StudyFlow · 基础组件库（单文件导出全部原子组件）
   配套样式走同一目录的 ui.css；页面只 import 本文件。
   ============================================================ */
import { useEffect, useId, useMemo, useRef } from 'react'
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  JSX,
  ReactNode,
  RefAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes
} from 'react'
import { createPortal } from 'react-dom'
import { DAY_STATUS_LABEL } from '@shared/contracts'
import type { Tone } from '../lib/format'
import { ApiError, errorMessage } from '../lib/api'
import { clearToasts, dismissToast, pushToast, useToasts } from '../lib/toast'
import './ui.css'

// ───────────────────────────── 工具 ─────────────────────────────

function cx(...parts: unknown[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ')
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/** 0–1 与 0–100 两种写法的进度都接受（>1 视为百分比） */
function toRatio(progress: number): number {
  if (!Number.isFinite(progress)) return 0
  const ratio = progress > 1 ? progress / 100 : progress
  return Math.min(1, Math.max(0, ratio))
}

// ───────────────────────────── Button ─────────────────────────────

export type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'subtle'
export type ButtonSize = 'sm' | 'md' | 'lg'
export type ControlSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** 加载中：显示 spinner、锁点击、aria-busy */
  loading?: boolean
  /** 占满容器宽度 */
  block?: boolean
  type?: 'button' | 'submit' | 'reset'
}

/**
 * 按钮。默认 `variant="primary"`、`size="md"`、`type="button"`。
 * 其余原生属性（onClick / title / aria-* …）透传。
 */
export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  block = false,
  disabled,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      {...rest}
      type={type}
      className={cx('sf-btn', `sf-btn--${variant}`, `sf-btn--${size}`, block && 'sf-btn--block', loading && 'is-loading', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <Spinner size={size === 'sm' ? 12 : size === 'lg' ? 16 : 14} className="sf-btn__spin" /> : null}
      <span className="sf-btn__label">{children}</span>
    </button>
  )
}

// ───────────────────────────── Card ─────────────────────────────

export interface CardProps {
  children?: ReactNode
  title?: ReactNode
  subtitle?: ReactNode
  /** 右上角操作区 */
  actions?: ReactNode
  /** 卡片底部（分隔线之上） */
  footer?: ReactNode
  /** 去掉内容内边距（表格 / 列表铺满） */
  flush?: boolean
  /** 强调左边框 */
  tone?: 'default' | 'accent' | 'warn' | 'danger'
  className?: string
  /** 传了就整卡可点击（含键盘 Enter / Space） */
  onClick?: () => void
}

/** 卡片：标题区可选，内容区默认 20px 内边距。 */
export function Card({
  children,
  title,
  subtitle,
  actions,
  footer,
  flush = false,
  tone = 'default',
  className,
  onClick
}: CardProps): JSX.Element {
  const clickable = typeof onClick === 'function'
  return (
    <section
      className={cx('sf-card', `sf-card--${tone}`, clickable && 'is-clickable', className)}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onClick()
              }
            }
          : undefined
      }
    >
      {title || actions ? (
        <header className="sf-card__head">
          <div className="sf-card__heading">
            {title ? <h3 className="sf-card__title">{title}</h3> : null}
            {subtitle ? <p className="sf-card__subtitle">{subtitle}</p> : null}
          </div>
          {actions ? <div className="sf-card__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cx('sf-card__body', flush && 'is-flush')}>{children}</div>
      {footer ? <footer className="sf-card__footer">{footer}</footer> : null}
    </section>
  )
}

// ───────────────────────────── 表单控件 ─────────────────────────────

interface FieldShellProps {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  htmlFor?: string
  className?: string
  children: ReactNode
}

function FieldShell({ label, hint, error, htmlFor, className, children }: FieldShellProps): JSX.Element {
  return (
    <div className={cx('sf-field', error ? 'is-error' : undefined, className)}>
      {label ? (
        <label className="sf-field__label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : null}
      {children}
      {error ? (
        <p className="sf-field__msg sf-field__msg--error">{error}</p>
      ) : hint ? (
        <p className="sf-field__msg">{hint}</p>
      ) : null}
    </div>
  )
}

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>,
    RefAttributes<HTMLInputElement> {
  size?: ControlSize
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  /** 右侧附属内容：单位、快捷键提示等 */
  suffix?: ReactNode
}

/** 单行输入框（label / hint / error / suffix 可选）。 */
export function Input({
  size = 'md',
  label,
  hint,
  error,
  suffix,
  className,
  id,
  ref,
  ...rest
}: InputProps): JSX.Element {
  const autoId = useId()
  const inputId = id ?? autoId
  return (
    <FieldShell label={label} hint={hint} error={error} htmlFor={inputId} className={className}>
      <div className={cx('sf-control', `sf-control--${size}`, error && 'is-error', suffix && 'has-suffix')}>
        <input
          {...rest}
          ref={ref}
          id={inputId}
          className="sf-control__input"
          aria-invalid={error ? true : undefined}
        />
        {suffix ? <span className="sf-control__suffix">{suffix}</span> : null}
      </div>
    </FieldShell>
  )
}

export interface TextAreaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'size'>,
    RefAttributes<HTMLTextAreaElement> {
  size?: ControlSize
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
}

/** 多行输入框，默认 4 行，手动拉伸（水平锁定）。 */
export function TextArea({
  size = 'md',
  label,
  hint,
  error,
  className,
  id,
  rows = 4,
  ref,
  ...rest
}: TextAreaProps): JSX.Element {
  const autoId = useId()
  const areaId = id ?? autoId
  return (
    <FieldShell label={label} hint={hint} error={error} htmlFor={areaId} className={className}>
      <div className={cx('sf-control', 'sf-control--area', `sf-control--${size}`, error && 'is-error')}>
        <textarea {...rest} ref={ref} id={areaId} rows={rows} className="sf-control__input" aria-invalid={error ? true : undefined} />
      </div>
    </FieldShell>
  )
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'>,
    RefAttributes<HTMLSelectElement> {
  size?: ControlSize
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
}

/** 原生下拉（键盘/输入法行为最稳，不做自绘浮层）。 */
export function Select({
  size = 'md',
  label,
  hint,
  error,
  className,
  id,
  children,
  ref,
  ...rest
}: SelectProps): JSX.Element {
  const autoId = useId()
  const selectId = id ?? autoId
  return (
    <FieldShell label={label} hint={hint} error={error} htmlFor={selectId} className={className}>
      <div className={cx('sf-control', 'sf-control--select', `sf-control--${size}`, error && 'is-error')}>
        <select {...rest} ref={ref} id={selectId} className="sf-control__input" aria-invalid={error ? true : undefined}>
          {children}
        </select>
        <span className="sf-control__chevron" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </div>
    </FieldShell>
  )
}

// ───────────────────────────── Badge ─────────────────────────────

export interface BadgeProps {
  children?: ReactNode
  tone?: Tone
  /** 前置小圆点（状态类徽标用） */
  dot?: boolean
  size?: 'sm' | 'md'
  className?: string
}

/** 语义徽标。tone 与 day 状态共用一套色（见 format.statusTone）。 */
export function Badge({ children, tone = 'neutral', dot = false, size = 'md', className }: BadgeProps): JSX.Element {
  return (
    <span className={cx('sf-badge', `sf-badge--${tone}`, `sf-badge--${size}`, className)}>
      {dot ? <i className="sf-badge__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  )
}

// ───────────────────────────── ProgressRing ─────────────────────────────

export interface ProgressRingProps {
  /** 0–100 */
  value: number
  /** 外径 px，默认 96 */
  size?: number
  /** 线宽 px，默认 7 */
  stroke?: number
  tone?: Tone
  className?: string
  /** 环内居中插槽（大数字、百分比、小标题） */
  children?: ReactNode
  ariaLabel?: string
}

/** 环形进度。数值为 0–100，圆环从 12 点方向顺时针增长。 */
export function ProgressRing({
  value,
  size = 96,
  stroke = 7,
  tone = 'accent',
  className,
  children,
  ariaLabel
}: ProgressRingProps): JSX.Element {
  const pct = clampPercent(value)
  const radius = Math.max(1, (size - stroke) / 2)
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - pct / 100)
  const center = size / 2
  return (
    <div
      className={cx('sf-ring', `sf-ring--${tone}`, className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={ariaLabel ?? `完成 ${Math.round(pct)}%`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="sf-ring__track" cx={center} cy={center} r={radius} fill="none" strokeWidth={stroke} />
        <circle
          className="sf-ring__value"
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${center} ${center})`}
        />
      </svg>
      <div className="sf-ring__center">{children}</div>
    </div>
  )
}

// ───────────────────────────── SegmentedBar ─────────────────────────────

export interface DaySegment {
  /** 0–1 或 0–100 */
  progress: number
  /** 契约的 DayStatus 字符串（locked / learning / exam_ready / passed / partial / failed） */
  status: string
  /** 悬浮提示里的名字，默认「第 N 天」 */
  label?: string
}

export interface SegmentedBarProps {
  /** 一个元素 = 一天 */
  segments: DaySegment[]
  /** 单格高度 px，默认 10 */
  height?: number
  /** 格间距 px，默认 4 */
  gap?: number
  /** 传入后每格可点击（通常跳转 #/day/:id） */
  onSelect?: (index: number) => void
  className?: string
  ariaLabel?: string
}

function segmentTone(status: string): Tone {
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
    default:
      return 'neutral'
  }
}

/**
 * 日进度条：一天一格，格内填充该天完成度，颜色来自 day.status。
 * 用于 Dashboard 的计划全景（几十格也不会挤）。
 */
export function SegmentedBar({
  segments,
  height = 10,
  gap = 4,
  onSelect,
  className,
  ariaLabel
}: SegmentedBarProps): JSX.Element {
  const interactive = typeof onSelect === 'function'
  return (
    <div
      className={cx('sf-segbar', interactive && 'is-interactive', className)}
      style={{ gap, height }}
      role={interactive ? 'group' : 'img'}
      aria-label={ariaLabel ?? `共 ${segments.length} 天，已通过 ${segments.filter((s) => s.status === 'passed').length} 天`}
    >
      {segments.map((segment, index) => {
        const statusText = (DAY_STATUS_LABEL as Record<string, string>)[segment.status] ?? segment.status
        const pct = Math.round(toRatio(segment.progress) * 100)
        const title = `${segment.label ?? `第 ${index + 1} 天`} · ${statusText}${pct > 0 ? ` · ${pct}%` : ''}`
        const inner = <i className="sf-segbar__fill" style={{ width: `${pct}%` }} aria-hidden="true" />
        const toneClass = `sf-segbar__seg--${segmentTone(segment.status)}`
        if (interactive) {
          return (
            <button
              key={index}
              type="button"
              className={cx('sf-segbar__seg', toneClass)}
              title={title}
              aria-label={title}
              onClick={() => onSelect(index)}
            >
              {inner}
            </button>
          )
        }
        return (
          <div key={index} className={cx('sf-segbar__seg', toneClass)} title={title}>
            {inner}
          </div>
        )
      })}
    </div>
  )
}

// ───────────────────────────── Modal ─────────────────────────────

export interface ModalProps {
  open: boolean
  title?: ReactNode
  children?: ReactNode
  /** 底部按钮区（右对齐） */
  footer?: ReactNode
  onClose: () => void
  /** 默认 480；数字按 px，也可以传 '80vw' */
  width?: number | string
  closeOnOverlay?: boolean
  closeOnEsc?: boolean
  className?: string
}

/**
 * 模态框：portal 到 body、双 overlay 点击关闭、ESC 关闭、焦点陷阱 + 关闭后焦点归还。
 * 打开时锁 body 滚动。
 */
export function Modal({
  open,
  title,
  children,
  footer,
  onClose,
  width = 480,
  closeOnOverlay = true,
  closeOnEsc = true,
  className
}: ModalProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return undefined

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const focusTimer = window.setTimeout(() => {
      const root = panelRef.current
      if (!root) return
      const target =
        root.querySelector<HTMLElement>('[data-autofocus]') ??
        root.querySelector<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
      ;(target ?? root).focus()
    }, 0)

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && closeOnEsc) {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab') return

      const root = panelRef.current
      if (!root) return
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null)
      if (focusables.length === 0) {
        event.preventDefault()
        root.focus()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      previouslyFocused?.focus()
    }
  }, [open, closeOnEsc])

  if (!open) return null

  return createPortal(
    <div className="sf-modal">
      <div
        className="sf-modal__overlay"
        onClick={closeOnOverlay ? onClose : undefined}
        aria-hidden="true"
      />
      <div
        className={cx('sf-modal__panel', className)}
        style={{ width: typeof width === 'number' ? `${width}px` : width }}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        tabIndex={-1}
        ref={panelRef}
      >
        {title ? (
          <header className="sf-modal__head">
            <h2 className="sf-modal__title">{title}</h2>
            <button type="button" className="sf-modal__close" onClick={onClose} aria-label="关闭">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </header>
        ) : null}
        <div className="sf-modal__body">{children}</div>
        {footer ? <footer className="sf-modal__footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body
  )
}

// ───────────────────────────── Toast ─────────────────────────────

export type ToastTone = 'info' | 'success' | 'warn' | 'danger'

export interface ToastApi {
  /** 推一条提示，返回 id */
  toast: (message: string, tone?: ToastTone) => string
  success: (message: string) => string
  warn: (message: string) => string
  danger: (message: string) => string
  /** 不传 id = 清空全部 */
  dismiss: (id?: string) => void
  clear: () => void
}

/** 命令式 toast API（组件内使用；store 层用 store.toast）。 */
export function useToast(): ToastApi {
  return useMemo<ToastApi>(
    () => ({
      toast: (message, tone = 'info') => pushToast(message, tone),
      success: (message) => pushToast(message, 'success'),
      warn: (message) => pushToast(message, 'warn'),
      danger: (message) => pushToast(message, 'danger'),
      dismiss: (id) => {
        if (id) dismissToast(id)
        else clearToasts()
      },
      clear: clearToasts
    }),
    []
  )
}

const TOAST_ICON: Record<ToastTone, ReactNode> = {
  info: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M7 6.2v3.4M7 4.3v.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  success: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M2.4 7.4 5.4 10.3 11.6 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  warn: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 2.2 12.4 11H1.6L7 2.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M7 5.7v2.5M7 9.6v.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  danger: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.8 4.8l4.4 4.4M9.2 4.8 4.8 9.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** Toast 渲染宿主：挂在 App 根部（已 portal 到 body，不占布局）。 */
export function ToastHost(): JSX.Element | null {
  const items = useToasts()
  if (items.length === 0) return null
  return createPortal(
    <div className="sf-toasts" role="status" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={cx('sf-toast', `sf-toast--${item.tone}`)}>
          <span className="sf-toast__icon" aria-hidden="true">
            {TOAST_ICON[item.tone as ToastTone]}
          </span>
          <span className="sf-toast__msg">{item.message}</span>
          <button type="button" className="sf-toast__close" onClick={() => dismissToast(item.id)} aria-label="关闭提示">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
    </div>,
    document.body
  )
}

// ───────────────────────────── Spinner / Skeleton ─────────────────────────────

export interface SpinnerProps {
  /** px，默认 16 */
  size?: number
  className?: string
  /** 给屏幕阅读器的文案；不传则视为纯装饰 */
  label?: string
}

export function Spinner({ size = 16, className, label }: SpinnerProps): JSX.Element {
  return (
    <span
      className={cx('sf-spinner', className)}
      style={{ width: size, height: size }}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.16" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </span>
  )
}

export interface SkeletonProps {
  width?: number | string
  height?: number | string
  /** 圆角，默认跟随令牌 --r-sm */
  radius?: number | string
  /** 圆形骨架（头像位） */
  circle?: boolean
  /** >1 时渲染多行，最后一行自动短一点 */
  lines?: number
  className?: string
}

/** 骨架屏：加载占位，自带 shimmer；屏幕阅读器忽略。 */
export function Skeleton({
  width = '100%',
  height = 14,
  radius,
  circle = false,
  lines = 1,
  className
}: SkeletonProps): JSX.Element {
  if (lines > 1) {
    const rows = Array.from({ length: lines }, (_, index) => index)
    return (
      <div className={cx('sf-skeleton-group', className)} aria-hidden="true">
        {rows.map((row) => (
          <div
            key={row}
            className="sf-skeleton"
            style={{
              width: row === rows.length - 1 ? '58%' : width,
              height,
              borderRadius: radius
            }}
          />
        ))}
      </div>
    )
  }
  return (
    <div
      className={cx('sf-skeleton', className)}
      style={{ width, height, borderRadius: circle ? '50%' : radius }}
      aria-hidden="true"
    />
  )
}

// ───────────────────────────── Empty / Error ─────────────────────────────

export interface EmptyStateProps {
  /** 图标（建议传 32–40px 的单色 svg） */
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  /** 主操作按钮 */
  action?: ReactNode
  className?: string
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps): JSX.Element {
  return (
    <div className={cx('sf-empty', className)}>
      {icon ? <div className="sf-empty__icon">{icon}</div> : null}
      <p className="sf-empty__title">{title}</p>
      {description ? <p className="sf-empty__desc">{description}</p> : null}
      {action ? <div className="sf-empty__action">{action}</div> : null}
    </div>
  )
}

export interface ErrorStateProps {
  /** 原始异常；为 ApiError 时会展示 codeLabel 且按可重试性显示按钮 */
  error?: unknown
  /** 覆盖文案（优先于 error） */
  message?: ReactNode
  onRetry?: () => void
  retryText?: string
  /** 紧凑模式：用于卡片内局部错误 */
  compact?: boolean
  className?: string
}

/** 错误态：文案 + 可选的「重试」按钮。 */
export function ErrorState({
  error,
  message,
  onRetry,
  retryText = '重试',
  compact = false,
  className
}: ErrorStateProps): JSX.Element {
  const detail = message ?? (error !== undefined ? errorMessage(error) : '加载失败')
  const codeLabel = error instanceof ApiError ? error.codeLabel : null
  const canRetry = typeof onRetry === 'function' && (!(error instanceof ApiError) || error.retryable)

  return (
    <div className={cx('sf-error', compact && 'is-compact', className)} role="alert">
      <div className="sf-error__icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <circle cx="9" cy="9" r="7.2" stroke="currentColor" strokeWidth="1.4" />
          <path d="M9 5.4v4.2M9 12.3v.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </div>
      <div className="sf-error__body">
        <p className="sf-error__title">出错了</p>
        <p className="sf-error__detail">{detail}</p>
        {codeLabel && codeLabel !== detail ? <p className="sf-error__code">{codeLabel}</p> : null}
      </div>
      {canRetry ? (
        <Button variant="ghost" size="sm" onClick={onRetry}>
          {retryText}
        </Button>
      ) : null}
    </div>
  )
}

// ───────────────────────────── KeyHint ─────────────────────────────

export interface KeyHintProps {
  /** 'Ctrl+Enter' 或 ['Ctrl', 'Enter'] */
  keys: string | string[]
  /** 快捷键说明（如「提交」）；不传只显示键帽 */
  children?: ReactNode
  className?: string
}

/** 键帽提示，用于「Ctrl+Enter 提交」这类一致性说明。 */
export function KeyHint({ keys, children, className }: KeyHintProps): JSX.Element {
  const list = (Array.isArray(keys) ? keys : [keys])
    .flatMap((key) => key.split('+'))
    .map((key) => key.trim())
    .filter(Boolean)

  return (
    <span className={cx('sf-keyhint', className)}>
      <span className="sf-keyhint__keys">
        {list.map((key, index) => (
          <kbd key={`${key}-${index}`} className="sf-kbd">
            {key}
          </kbd>
        ))}
      </span>
      {children ? <span className="sf-keyhint__label">{children}</span> : null}
    </span>
  )
}

// ───────────────────────────── Tabs ─────────────────────────────

export interface TabItem<K extends string = string> {
  key: K
  label: ReactNode
  /** 标签右侧小徽标（数量/状态） */
  badge?: ReactNode
  disabled?: boolean
}

export interface TabsProps<K extends string = string> {
  tabs: TabItem<K>[]
  value: K
  onChange: (key: K) => void
  size?: 'sm' | 'md'
  className?: string
  ariaLabel?: string
}

/** 下划线式 Tabs（受控）。 */
export function Tabs<K extends string = string>({
  tabs,
  value,
  onChange,
  size = 'md',
  className,
  ariaLabel
}: TabsProps<K>): JSX.Element {
  return (
    <div className={cx('sf-tabs', `sf-tabs--${size}`, className)} role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab) => {
        const active = tab.key === value
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={tab.disabled}
            className={cx('sf-tabs__tab', active && 'is-active')}
            onClick={() => {
              if (!active) onChange(tab.key)
            }}
          >
            <span>{tab.label}</span>
            {tab.badge ? <span className="sf-tabs__badge">{tab.badge}</span> : null}
          </button>
        )
      })}
    </div>
  )
}

// ───────────────────────────── Divider ─────────────────────────────

export interface DividerProps {
  /** 横线中间的文字 */
  label?: ReactNode
  orientation?: 'horizontal' | 'vertical'
  spacing?: 'sm' | 'md' | 'lg'
  className?: string
}

export function Divider({ label, orientation = 'horizontal', spacing = 'md', className }: DividerProps): JSX.Element {
  if (orientation === 'vertical') {
    return <span className={cx('sf-divider sf-divider--v', `sf-divider--${spacing}`, className)} aria-hidden="true" />
  }
  if (!label) {
    return <hr className={cx('sf-divider sf-divider--h', `sf-divider--${spacing}`, className)} />
  }
  return (
    <div className={cx('sf-divider-with-label', `sf-divider--${spacing}`, className)}>
      <span className="sf-divider__line" />
      <span className="sf-divider__label">{label}</span>
      <span className="sf-divider__line" />
    </div>
  )
}
