/* ============================================================
   StudyFlow · 自动更新（electron-updater）
   - 只在打包后的应用里生效；开发模式直接返回提示
   - autoDownload = false：先告诉用户有新版本，用户点了才下载
   - 任何异常都收敛成 UpdateStatus.error，不抛到界面
   ============================================================ */
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/contracts'
import { PUSH } from '../shared/contracts'
import { broadcast } from './db/bus'
import { AppError } from './ipc/handle'
import { logger } from './util/logger'

let current: UpdateStatus = { state: 'idle', version: null, percent: null, message: null }
let wired = false

function push(patch: Partial<UpdateStatus>): UpdateStatus {
  current = { ...current, ...patch }
  broadcast(PUSH.UPDATE_STATUS, current)
  return current
}

function describe(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error)
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|net::|fetch failed/i.test(msg)) {
    return '检查更新失败：网络连不上 GitHub，请开代理后再试'
  }
  if (/404|latest\.yml/i.test(msg)) return '检查更新失败：没有找到更新清单（latest.yml）'
  return `检查更新失败：${msg}`
}

export function getUpdateStatus(): UpdateStatus {
  return current
}

/** 应用启动时调用一次；只在打包版里真正工作 */
export function setupUpdater(): void {
  if (wired || !app.isPackaged) return
  wired = true

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = {
    info: (m: unknown) => logger.info('update', String(m)),
    warn: (m: unknown) => logger.warn('update', String(m)),
    error: (m: unknown) => logger.error('update', String(m)),
    debug: () => undefined,
  } as never

  autoUpdater.on('checking-for-update', () => push({ state: 'checking', message: '正在检查更新…' }))
  autoUpdater.on('update-available', (info) =>
    push({
      state: 'available',
      version: info.version,
      percent: 0,
      message: `发现新版本 v${info.version}`,
    })
  )
  autoUpdater.on('update-not-available', () =>
    push({ state: 'not-available', version: null, percent: null, message: '已经是最新版本' })
  )
  autoUpdater.on('download-progress', (p) =>
    push({
      state: 'downloading',
      percent: Math.round(p.percent),
      message: `正在下载更新 ${Math.round(p.percent)}%`,
    })
  )
  autoUpdater.on('update-downloaded', (info) =>
    push({
      state: 'ready',
      version: info.version,
      percent: 100,
      message: `v${info.version} 已下载完成，重启后生效`,
    })
  )
  autoUpdater.on('error', (error) => push({ state: 'error', message: describe(error) }))

  // 启动 6 秒后静默检查一次（不打扰用户，失败也不弹窗）
  setTimeout(() => {
    void checkForUpdates().catch(() => undefined)
  }, 6000)
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    return push({ state: 'not-available', message: '开发模式不检查更新（打包版才生效）' })
  }
  push({ state: 'checking', message: '正在检查更新…' })
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    const message = describe(error)
    push({ state: 'error', message })
  }
  return current
}

export async function downloadUpdate(): Promise<UpdateStatus> {
  if (current.state !== 'available') {
    throw new AppError('VALIDATION', '还没有发现可下载的新版本，请先检查更新')
  }
  push({ state: 'downloading', percent: 0, message: '正在下载更新 0%' })
  try {
    await autoUpdater.downloadUpdate()
  } catch (error) {
    const message = describe(error)
    push({ state: 'error', message })
  }
  return current
}

export function installUpdate(): UpdateStatus {
  if (current.state !== 'ready') {
    throw new AppError('VALIDATION', '更新还没下载完，先点「下载更新」')
  }
  logger.info('update', '用户选择立即重启安装')
  // 让 IPC 的返回值先送回渲染进程，再退出
  setTimeout(() => autoUpdater.quitAndInstall(false, true), 300)
  return current
}
