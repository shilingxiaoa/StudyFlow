import { registerDbHandlers } from './dbHandlers'
import { registerAiHandlers } from './aiHandlers'
import { registerAuthHandlers } from './authHandlers'

/** 汇总注册所有 IPC 通道；主进程启动时调用一次 */
export function registerIpcHandlers(): void {
  registerAuthHandlers()
  registerDbHandlers()
  registerAiHandlers()
  console.log('[ipc] 通道注册完成')
}
