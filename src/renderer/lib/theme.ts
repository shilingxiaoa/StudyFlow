/**
 * 主题落地：把 settings.theme（dark / light / system）解析成
 * <html data-theme="dark|light">，CSS 只认 data-theme。
 */
import type { AppSettings } from '@shared/contracts'

export type ThemeMode = AppSettings['theme']
export type ResolvedTheme = 'dark' | 'light'

let systemBound = false

function prefersLight(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-color-scheme: light)').matches
}

/** 纯函数：给定模式算出实际主题（system 时读系统偏好） */
export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'light') return 'light'
  if (mode === 'dark') return 'dark'
  return prefersLight() ? 'light' : 'dark'
}

/**
 * 应用主题。系统模式会额外挂一个 matchMedia 监听（只挂一次），
 * 系统切换深浅色时自动跟随。
 */
export function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode)

  if (typeof document !== 'undefined') {
    const root = document.documentElement
    root.dataset.theme = resolved
    root.style.colorScheme = resolved
  }

  if (mode === 'system' && !systemBound) {
    systemBound = true
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
        applyTheme('system')
      })
    }
  }

  return resolved
}

/** 当前实际主题（读 DOM，供页面做主题相关判断） */
export function currentTheme(): ResolvedTheme {
  if (typeof document === 'undefined') return 'dark'
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}
