import { ipcMain } from 'electron'
import type { ErrorCode, Result } from '../../shared/contracts'

/** 业务异常：带错误码，统一转成 Result.error 返回渲染进程 */
export class AppError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'AppError'
    this.code = code
  }
}

function mapError(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof AppError) return { code: err.code, message: err.message }
  const e = err as { message?: string; name?: string; code?: string }
  const msg = e?.message ?? String(err)
  if (e?.name === 'AbortError') return { code: 'TIMEOUT', message: '请求超时，请稍后重试' }
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed/i.test(msg)) {
    return { code: 'NETWORK', message: '网络连接失败，请检查网络或代理设置' }
  }
  return { code: 'UNKNOWN', message: msg }
}

/**
 * 注册一个 invoke 通道：永远不向渲染进程抛异常，统一返回 Result。
 * 用法：handle(IPC.GOAL_CREATE, (input: GoalInput) => repo.createGoal(input))
 */
export function handle<I, O>(
  channel: string,
  fn: (payload: I) => Promise<O> | O
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, async (_event, payload: I): Promise<Result<O>> => {
    try {
      const data = await fn(payload)
      return { ok: true, data }
    } catch (err) {
      const { code, message } = mapError(err)
      console.error(`[ipc] ${channel} 失败:`, err)
      return { ok: false, error: { code, message } }
    }
  })
}
