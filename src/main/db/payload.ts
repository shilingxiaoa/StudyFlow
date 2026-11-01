/**
 * IPC 入参兜底解析。
 * 前端可能传裸字符串、{ id }、{ goalId }、{ data: {...} }，这里统一容错；
 * 非法输入一律抛 AppError('VALIDATION')，绝不把 undefined 传进 SQL。
 */
import { AppError } from '../ipc/handle'

export function asRecord(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/** 读字符串字段（多个候选键名）；找不到返回 null */
export function pickString(payload: unknown, ...keys: string[]): string | null {
  const rec = asRecord(payload)
  const value = firstDefined(...keys.map((key) => rec[key]))
  if (value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

/** 读数字字段，非法/缺失返回 fallback */
export function pickNumber(payload: unknown, key: string, fallback?: number): number | undefined {
  const rec = asRecord(payload)
  const value = rec[key]
  if (value === undefined || value === null || value === '') return fallback
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : fallback
}

/** 读对象字段 */
export function pickObject(payload: unknown, ...keys: string[]): Record<string, unknown> | null {
  const rec = asRecord(payload)
  const value = firstDefined(...keys.map((key) => rec[key]))
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/** 必填字符串 */
export function requireString(payload: unknown, key: string, label: string): string {
  const value = pickString(payload, key)
  const trimmed = (value ?? '').trim()
  if (!trimmed) throw new AppError('VALIDATION', `缺少${label}`)
  return trimmed
}

/**
 * 读 id：支持 'abc' / { id:'abc' } / { dayId:'abc' } / { data:{ id:'abc' } } / 数字
 */
export function readId(payload: unknown, ...keys: string[]): string {
  const candidates: string[] = keys.length > 0 ? keys : ['id']
  if (typeof payload === 'string' || typeof payload === 'number') return String(payload).trim()
  const rec = asRecord(payload)
  const nested = pickObject(rec, 'data', 'payload')
  for (const key of candidates) {
    const value = firstDefined(rec[key], nested ? nested[key] : undefined)
    if (value !== undefined && value !== null && typeof value !== 'object') return String(value).trim()
  }
  const fallback = firstDefined(rec.id, nested ? nested.id : undefined)
  return fallback === undefined || fallback === null ? '' : String(fallback).trim()
}

/** 读 id，缺失即报错 */
export function requireId(payload: unknown, label: string, ...keys: string[]): string {
  const id = readId(payload, ...keys)
  if (!id) throw new AppError('VALIDATION', `缺少${label}`)
  return id
}
