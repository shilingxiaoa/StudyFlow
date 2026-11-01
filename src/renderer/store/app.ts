/* ============================================================
   StudyFlow · 全局 UI 状态（Zustand）
   - boot：一份 bootstrap 快照，页面全部从这里取数据
   - 推送（progressChanged / taskChanged / settingsChanged）自动 refresh
   ============================================================ */
import { create } from 'zustand'
import type { BootstrapData } from '@shared/contracts'
import { IPC, PUSH } from '@shared/contracts'
import { call, errorMessage, onPush } from '../lib/api'
import { applyTheme } from '../lib/theme'
import type { ToastTone } from '../lib/toast'
import { pushToast } from '../lib/toast'

export interface AppState {
  boot: BootstrapData | null
  /** 首次加载 / 手动重载时为 true（驱动全屏 loading） */
  loading: boolean
  /** 首次加载失败的文案；已有数据时的后台刷新失败只 toast，不写这里 */
  error: string | null
  load: () => Promise<void>
  refresh: () => Promise<void>
  toast: (msg: string, tone?: 'info' | 'success' | 'warn' | 'danger') => void
}

/** 防止同一时刻并发刷新（推送风暴 / 页面同时请求） */
let refreshing = false
/** 推送去抖：连点任务状态会产生多条 push，只拉一次 */
let refreshTimer: number | undefined

async function fetchBootstrap(): Promise<BootstrapData> {
  const boot = await call<BootstrapData>(IPC.APP_BOOTSTRAP)
  // 主题跟随设置（dark / light / system），在这里落地最省心
  applyTheme(boot.settings.theme)
  return boot
}

export const useAppStore = create<AppState>()((set, get) => ({
  boot: null,
  loading: false,
  error: null,

  async load() {
    set({ loading: true, error: null })
    try {
      const boot = await fetchBootstrap()
      set({ boot, loading: false, error: null })
    } catch (err) {
      set({ loading: false, error: errorMessage(err) })
    }
  },

  /**
   * 静默刷新：不动 loading、不清空旧数据（避免页面闪烁）。
   * 推送回调与「完成任务后手动同步」都走这里。
   */
  async refresh() {
    if (refreshing) return
    refreshing = true
    try {
      const boot = await fetchBootstrap()
      set({ boot, loading: false, error: null })
    } catch (err) {
      if (get().boot) {
        // 已有数据：后台失败只提醒，别把界面打回错误态
        pushToast(errorMessage(err), 'warn')
      } else {
        set({ error: errorMessage(err), loading: false })
      }
    } finally {
      refreshing = false
    }
  },

  toast(msg, tone = 'info') {
    pushToast(msg, tone)
  }
}))

/** 去抖刷新（默认 180ms 内的多条推送合并成一次拉取） */
export function scheduleRefresh(delay = 180): void {
  if (typeof window === 'undefined') return
  if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined
    void useAppStore.getState().refresh()
  }, delay)
}

let pushBound = false

/**
 * 订阅主进程推送（幂等，多次调用只绑定一次）。
 * 由 main.tsx 在挂载时调用；HMR 重复执行也不会重复订阅。
 */
export function bindPushListeners(): void {
  if (pushBound) return
  pushBound = true

  onPush(PUSH.PROGRESS_CHANGED, () => scheduleRefresh())
  onPush(PUSH.TASK_CHANGED, () => scheduleRefresh())
  onPush(PUSH.SETTINGS_CHANGED, () => {
    // 设置里可能改了主题，给 0 延迟立刻应用
    scheduleRefresh(0)
  })
}

// ── 常用选择器（页面直接 useAppStore(selectXxx) 即可） ──
export const selectBoot = (state: AppState): BootstrapData | null => state.boot
export const selectGoals = (state: AppState): BootstrapData['goals'] => state.boot?.goals ?? []
export const selectSettings = (state: AppState): BootstrapData['settings'] | null => state.boot?.settings ?? null
export const selectActivePlan = (state: AppState): BootstrapData['activePlan'] => state.boot?.activePlan ?? null
export const selectTodayDay = (state: AppState): BootstrapData['todayDay'] => state.boot?.todayDay ?? null
export const selectProgress = (state: AppState): BootstrapData['progress'] => state.boot?.progress ?? null
