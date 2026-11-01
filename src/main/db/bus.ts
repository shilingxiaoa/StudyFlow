/**
 * 主进程 → 渲染进程的推送通道（契约里的 PUSH.*）。
 * 任何失败都不允许影响主流程，所以统一 try/catch。
 */
import { BrowserWindow } from 'electron'
import { logger } from '../util/logger'

export function broadcast(channel: string, payload: unknown): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  } catch (err) {
    logger.warn('bus', `推送失败（忽略）: ${channel}`, err)
  }
}
