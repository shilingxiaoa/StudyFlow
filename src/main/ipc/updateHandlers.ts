import { app } from 'electron'
import type { AppInfo } from '../../shared/contracts'
import { IPC } from '../../shared/contracts'
import { handle } from './handle'
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateStatus,
  installUpdate,
} from '../updater'

/** 应用信息 + 自动更新相关的 IPC */
export function registerUpdateHandlers(): void {
  handle<void, AppInfo>(IPC.APP_INFO, () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    electron: process.versions.electron,
  }))

  // 打开设置页时先拿一次当前状态（可能已经在下 / 已经下完）
  handle<void, ReturnType<typeof getUpdateStatus>>(IPC.UPDATE_STATUS_REQ, () => getUpdateStatus())

  handle<void, Awaited<ReturnType<typeof checkForUpdates>>>(IPC.UPDATE_CHECK, () =>
    checkForUpdates()
  )
  handle<void, Awaited<ReturnType<typeof downloadUpdate>>>(IPC.UPDATE_DOWNLOAD, () =>
    downloadUpdate()
  )
  handle<void, ReturnType<typeof installUpdate>>(IPC.UPDATE_INSTALL, () => installUpdate())
}
