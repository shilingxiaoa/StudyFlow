import { registerDbHandlers } from './dbHandlers'
import { registerAiHandlers } from './aiHandlers'

/** 汇总注册所有 IPC 通道；主进程启动时调用一次 */
export function registerIpcHandlers(): void {
  registerDbHandlers()
  registerAiHandlers()
  console.log('[ipc] 通道注册完成')
}
