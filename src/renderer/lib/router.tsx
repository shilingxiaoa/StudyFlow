/**
 * StudyFlow · 自研 hash 路由（零依赖）
 *
 * 为什么不用 react-router：只有一个窗口、7 条固定路径、无嵌套路由，
 * 手写 60 行比拉一个依赖更可控（也符合「不引新依赖」的约束）。
 *
 * 地址形如 `#/day/abc?from=home`：
 *   - `path`   = `/day/abc`（去掉 hash、查询串、末尾斜杠）
 *   - `params` = `{ dayId: 'abc', from: 'home' }`（路径参数优先于查询串）
 */
import { useMemo, useSyncExternalStore } from 'react'
import type { JSX, MouseEvent, ReactNode } from 'react'

export type Route = { path: string; params: Record<string, string> }

/**
 * 路由模式表 —— 与 App.tsx 的页面分发一一对应。
 * 静态路径写死，参数段用 `:name`；顺序即匹配优先级。
 */
const ROUTES = [
  '/',
  '/setup',
  '/day/:dayId',
  '/exam/:examId',
  '/plan/new',
  '/stats',
  '/settings'
] as const

/** 拆出 path 与查询串，并做归一化（补前导斜杠、去末尾斜杠） */
function normalize(raw: string): { path: string; search: string } {
  const hash = raw.startsWith('#') ? raw.slice(1) : raw
  const queryIndex = hash.indexOf('?')
  const bare = queryIndex >= 0 ? hash.slice(0, queryIndex) : hash
  const search = queryIndex >= 0 ? hash.slice(queryIndex + 1) : ''
  const withSlash = bare.startsWith('/') ? bare : `/${bare}`
  const trimmed = withSlash.replace(/\/+$/, '')
  return { path: trimmed === '' ? '/' : trimmed, search }
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseQuery(search: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!search) return out
  for (const part of search.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const key = decodeSafe(eq >= 0 ? part.slice(0, eq) : part)
    if (!key) continue
    out[key] = eq >= 0 ? decodeSafe(part.slice(eq + 1)) : ''
  }
  return out
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter(Boolean)
}

/** 模式匹配 + 参数提取；不匹配返回 null */
function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const patternSegs = segmentsOf(pattern)
  const pathSegs = segmentsOf(path)
  if (patternSegs.length !== pathSegs.length) return null

  const params: Record<string, string> = {}
  for (let i = 0; i < patternSegs.length; i += 1) {
    const patternSeg = patternSegs[i]
    const pathSeg = pathSegs[i]
    if (patternSeg.startsWith(':')) {
      params[patternSeg.slice(1)] = decodeSafe(pathSeg)
      continue
    }
    if (patternSeg !== pathSeg) return null
  }
  return params
}

function parseHash(raw: string): Route {
  const { path, search } = normalize(raw)
  const query = parseQuery(search)

  for (const pattern of ROUTES) {
    const params = matchPattern(pattern, path)
    if (params) return { path, params: { ...query, ...params } }
  }
  // 未登记的路径：原样返回，交给 App.tsx 渲染 404
  return { path, params: query }
}

function getHash(): string {
  return typeof window === 'undefined' ? '' : window.location.hash
}

function subscribeHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => {
    window.removeEventListener('hashchange', onChange)
  }
}

/** 当前路由（hashchange 自动触发重渲染） */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribeHash, getHash, getHash)
  return useMemo(() => parseHash(hash), [hash])
}

function toHash(to: string): string {
  if (to.startsWith('#')) return to
  return `#${to.startsWith('/') ? '' : '/'}${to}`
}

/** 编程式跳转（同址跳转会广播一次 hashchange，方便页面做「重试」） */
export function navigate(to: string): void {
  if (typeof window === 'undefined') return
  const target = toHash(to)
  if (window.location.hash === target) {
    window.dispatchEvent(new Event('hashchange'))
    return
  }
  window.location.hash = target
}

/**
 * 声明式链接。渲染真 <a href>，保证中键/右键「复制链接」可用；
 * 左键点击走 hash 跳转（不刷新页面）。
 */
export function Link({
  to,
  children,
  className
}: {
  to: string
  children: ReactNode
  className?: string
}): JSX.Element {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.defaultPrevented) return
    // 修饰键 / 非左键：交回浏览器默认行为
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return
    }
    event.preventDefault()
    navigate(to)
  }

  return (
    <a className={className} href={toHash(to)} onClick={handleClick}>
      {children}
    </a>
  )
}
