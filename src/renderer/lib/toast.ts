/**
 * Toast 通知的「无组件状态容器」。
 *
 * 放在 lib 里（而不是 ui.tsx）的原因：store/app.ts 的 `toast()` 也要用，
 * 而 store 不应该 import 组件文件（会引入 CSS 循环）。ui.tsx 只负责渲染。
 */
import { useSyncExternalStore } from 'react'

export type ToastTone = 'info' | 'success' | 'warn' | 'danger'

export interface ToastItem {
  id: string
  message: string
  tone: ToastTone
  /** 毫秒；<= 0 表示不自动消失 */
  duration: number
  createdAt: number
}

const MAX_TOASTS = 4
const DEFAULT_DURATION = 3200

let items: ToastItem[] = []
let seq = 0
const listeners = new Set<() => void>()
const timers = new Map<string, number>()

function emit(): void {
  for (const listener of listeners) listener()
}

function nextId(): string {
  seq += 1
  return `t_${Date.now().toString(36)}_${seq}`
}

function clearTimer(id: string): void {
  const timer = timers.get(id)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    timers.delete(id)
  }
}

/** 推一条 toast，返回 id（可用于手动 dismiss） */
export function pushToast(
  message: string,
  tone: ToastTone = 'info',
  duration: number = DEFAULT_DURATION
): string {
  const text = String(message ?? '').trim()
  if (!text) return ''

  const id = nextId()
  const next = [...items, { id, message: text, tone, duration, createdAt: Date.now() }]
  items = next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next
  emit()

  // 被挤出的旧 toast：清掉它的定时器，避免泄漏
  for (const [timerId, timer] of timers) {
    if (!items.some((item) => item.id === timerId)) {
      window.clearTimeout(timer)
      timers.delete(timerId)
    }
  }

  if (duration > 0) {
    timers.set(
      id,
      window.setTimeout(() => {
        timers.delete(id)
        dismissToast(id)
      }, duration)
    )
  }
  return id
}

export function dismissToast(id: string): void {
  if (!id) return
  clearTimer(id)
  const next = items.filter((item) => item.id !== id)
  if (next.length === items.length) return
  items = next
  emit()
}

export function clearToasts(): void {
  for (const timer of timers.values()) window.clearTimeout(timer)
  timers.clear()
  if (items.length === 0) return
  items = []
  emit()
}

export function getToasts(): ToastItem[] {
  return items
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** React 侧读取当前 toast 列表（供 ToastHost 使用） */
export function useToasts(): ToastItem[] {
  return useSyncExternalStore(subscribeToasts, getToasts, getToasts)
}
