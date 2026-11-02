/* ============================================================
   StudyFlow · 全局 UI 状态（Zustand）
   - boot：一份 bootstrap 快照，页面全部从这里取数据
   - 推送（progressChanged / taskChanged / settingsChanged）自动 refresh
   ============================================================ */
import { create } from 'zustand'
import type { AuthStatus, BootstrapData } from '@shared/contracts'
import { IPC, PUSH } from '@shared/contracts'
import { call, errorCode, errorMessage, onPush } from '../lib/api'
import { applyTheme } from '../lib/theme'
import type { ToastTone } from '../lib/toast'
import { pushToast } from '../lib/toast'

export interface AppState {
  boot: BootstrapData | null
  /** 首次加载 / 手动重载时为 true（驱动全屏 loading） */
  loading: boolean
  /** 首次加载失败的文案；已有数据时的后台刷新失败只 toast，不写这里 */
  error: string | null
  /** 本地登录状态；null = 还没问过主进程（启动守卫据此显示启动屏） */
  auth: AuthStatus | null
  /** 正在读取 auth:status */
  authLoading: boolean
  /** 读取登录状态失败（例如 IPC 异常）；非 null 时启动屏显示可重试的错误页 */
  authError: string | null
  load: () => Promise<void>
  refresh: () => Promise<void>
  /** 拉一次 auth:status 写入 state；失败 toast 并记录 authError（可重试） */
  loadAuth: () => Promise<void>
  /** 设置页改完密码等场景下静默刷新登录状态 */
  refreshAuth: () => Promise<void>
  /** 退出登录：成功后回写 AuthStatus 并清空 boot，App 自动回到登录页 */
  logout: () => Promise<void>
  /** 收到 push:authChanged 时同步登录态（自动登录 / 被登出 / 改密码重建会话） */
  applyAuth: (auth: AuthStatus) => void
  /** 切换当前目标 / 当前计划（主进程会持久化选择，并把整份 bootstrap 送回来） */
  setContext: (input: { goalId?: string | null; planId?: string | null }) => Promise<void>
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

async function fetchAuthStatus(): Promise<AuthStatus> {
  return call<AuthStatus>(IPC.AUTH_STATUS)
}

/** 主进程说「未登录」时的兜底状态：保留已知的 hasAccounts / legacy 信息 */
function signedOutStatus(current: AuthStatus | null): AuthStatus {
  return {
    authenticated: false,
    account: null,
    hasAccounts: current?.hasAccounts ?? true,
    legacyDataAvailable: current?.legacyDataAvailable ?? false
  }
}

export const useAppStore = create<AppState>()((set, get) => ({
  boot: null,
  loading: false,
  error: null,
  auth: null,
  authLoading: false,
  authError: null,

  async load() {
    set({ loading: true, error: null })
    try {
      // 先确认登录状态：未登录时 bootstrap 只会返回 AUTH_REQUIRED，不必白跑一趟
      const auth = await fetchAuthStatus()
      set({ auth, authLoading: false, authError: null })
      if (!auth.authenticated) {
        set({ boot: null, loading: false, error: null })
        return
      }
      const boot = await fetchBootstrap()
      set({ boot, loading: false, error: null })
    } catch (err) {
      if (errorCode(err) === 'AUTH_REQUIRED') {
        // 未登录不是致命错误：把界面交回登录页，不要弹错误页
        set({ auth: signedOutStatus(get().auth), boot: null, loading: false, error: null })
        return
      }
      set({ loading: false, error: errorMessage(err) })
    }
  },

  async loadAuth() {
    set({ authLoading: true, authError: null })
    try {
      const auth = await fetchAuthStatus()
      set({ auth, authLoading: false, authError: null })
      // 没登录时旧数据快照属于上一个会话，清掉避免串数据
      if (!auth.authenticated) set({ boot: null, error: null })
    } catch (err) {
      const message = errorMessage(err)
      set({ authLoading: false, authError: message })
      pushToast(message, 'warn')
    }
  },

  async refreshAuth() {
    await get().loadAuth()
  },

  /**
   * 收到主进程的 push:authChanged 时调用。
   * 登录态变化可能来自别处（例如自动化脚本直接调 IPC），界面必须跟着切，
   * 否则会卡在登录页 / 卡在已登录界面。
   */
  applyAuth(auth: AuthStatus) {
    const wasAuthed = get().auth?.authenticated === true
    set({ auth, authLoading: false, authError: null })
    if (!auth.authenticated) {
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer)
        refreshTimer = undefined
      }
      set({ boot: null, loading: false, error: null })
      return
    }
    if (!wasAuthed) void get().load()
  },

  async logout() {
    try {
      const auth = await call<AuthStatus>(IPC.AUTH_LOGOUT)
      // 退出后可能还有排队中的推送刷新：取消掉，否则会刷出一串「请先登录」
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer)
        refreshTimer = undefined
      }
      set({ auth, boot: null, loading: false, error: null })
    } catch (err) {
      pushToast(errorMessage(err), 'danger')
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
      // 会话过期：交给登录页，别在已登录界面上反复弹「请先登录」
      if (errorCode(err) === 'AUTH_REQUIRED') {
        set({ auth: signedOutStatus(get().auth), boot: null, loading: false, error: null })
        return
      }
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
  },

  async setContext(input) {
    try {
      const boot = await call<BootstrapData>(IPC.CONTEXT_SET, input)
      applyTheme(boot.settings.theme)
      set({ boot, loading: false, error: null })
    } catch (err) {
      pushToast(errorMessage(err), 'warn')
    }
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
  onPush(PUSH.AUTH_CHANGED, (status) => {
    if (status && typeof status === 'object') {
      useAppStore.getState().applyAuth(status as AuthStatus)
    } else {
      void useAppStore.getState().loadAuth()
    }
  })
}

// ── 常用选择器（页面直接 useAppStore(selectXxx) 即可） ──
export const selectBoot = (state: AppState): BootstrapData | null => state.boot
export const selectGoals = (state: AppState): BootstrapData['goals'] => state.boot?.goals ?? []
export const selectActiveGoalId = (state: AppState): string | null => state.boot?.activeGoalId ?? null
export const selectPlans = (state: AppState): BootstrapData['plans'] => state.boot?.plans ?? []
export const selectActiveGoal = (state: AppState): BootstrapData['goals'][number] | null => {
  const boot = state.boot
  if (!boot || boot.activeGoalId === null) return null
  return boot.goals.find((goal) => goal.id === boot.activeGoalId) ?? null
}
export const selectSettings = (state: AppState): BootstrapData['settings'] | null => state.boot?.settings ?? null
export const selectActivePlan = (state: AppState): BootstrapData['activePlan'] => state.boot?.activePlan ?? null
export const selectTodayDay = (state: AppState): BootstrapData['todayDay'] => state.boot?.todayDay ?? null
export const selectProgress = (state: AppState): BootstrapData['progress'] => state.boot?.progress ?? null
