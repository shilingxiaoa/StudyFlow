/**
 * 渲染进程 ↔ 主进程的唯一通道封装。
 *
 * 约定：主进程永远返回 Result<T>（{ ok:true, data } | { ok:false, error }），
 * 因此页面里可以放心写 `const days = await call<Day[]>('day:list')`，
 * 失败时统一 throw ApiError，交给 ErrorState / toast 处理。
 */
import type { ErrorCode, IpcChannel, RendererApi, Result } from '@shared/contracts'

/** 错误码 → 人话。页面可以直接展示，不用自己再写一版文案 */
export const CODE_LABEL: Record<ErrorCode, string> = {
  NO_API_KEY: '还没有配置 API Key',
  INVALID_API_KEY: 'API Key 无效',
  INSUFFICIENT_BALANCE: '账户余额不足',
  RATE_LIMITED: '请求太频繁，请稍后再试',
  NETWORK: '网络连接失败',
  TIMEOUT: '请求超时',
  AI_BAD_OUTPUT: 'AI 返回内容无法解析',
  NOT_FOUND: '找不到对应的数据',
  VALIDATION: '输入内容不合法',
  DB: '本地数据读写失败',
  UNKNOWN: '发生了未知错误'
}

/** 这些错误重试有意义（其余重试也是一样的结果） */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'NETWORK',
  'TIMEOUT',
  'RATE_LIMITED',
  'AI_BAD_OUTPUT',
  'DB',
  'UNKNOWN'
])

/**
 * IPC 业务错误。
 * - `code`     契约里的 ErrorCode，可用于分流（例如 NO_API_KEY → 引导去设置页）
 * - `codeLabel` ErrorCode 的中文标签
 * - `message`  主进程给的原始信息（可能更具体）
 */
export class ApiError extends Error {
  readonly code: ErrorCode
  readonly codeLabel: string

  constructor(code: ErrorCode, message?: string) {
    super(message && message.trim() ? message : CODE_LABEL[code])
    this.name = 'ApiError'
    this.code = code
    this.codeLabel = CODE_LABEL[code]
    // 兼容被编译到 ES5 target 时的 instanceof 判定
    Object.setPrototypeOf(this, ApiError.prototype)
  }

  /** 是否值得重试（ErrorState 用它决定要不要显示重试按钮） */
  get retryable(): boolean {
    return RETRYABLE.has(this.code)
  }
}

function getApi(): RendererApi {
  if (typeof window === 'undefined' || !window.api) {
    // 理论上只会在纯浏览器里跑 vite dev 时出现
    throw new ApiError('UNKNOWN', 'window.api 不可用：请通过 Electron 启动应用')
  }
  return window.api
}

/**
 * 调用一个 IPC 通道。
 * @param payload 主进程 handler 的第二参数（无参通道可省略）
 * @throws {ApiError} ok:false 或通信层异常
 */
export async function call<T>(channel: IpcChannel, payload?: unknown): Promise<T> {
  const api = getApi()

  let result: Result<T>
  try {
    result = await api.invoke<T>(channel, payload)
  } catch (raw) {
    // preload 抛错 / 通道没注册：包成 ApiError，页面无需区分
    throw new ApiError('UNKNOWN', raw instanceof Error ? raw.message : `通道 ${channel} 调用失败`)
  }

  if (!result || typeof result !== 'object' || !('ok' in result)) {
    throw new ApiError('UNKNOWN', `通道 ${channel} 返回了非法响应`)
  }
  if (!result.ok) {
    throw new ApiError(result.error.code, result.error.message)
  }
  return result.data
}

/**
 * 订阅主进程推送（push:progressChanged / push:taskChanged / push:settingsChanged / push:aiStage）。
 * 返回退订函数；组件里必须放到 useEffect 的 cleanup 里。
 */
export function onPush(channel: string, cb: (p: unknown) => void): () => void {
  if (typeof window === 'undefined' || !window.api) return () => {}
  return window.api.on(channel, (payload) => {
    try {
      cb(payload)
    } catch (err) {
      // 一个订阅者出错不能影响其他订阅者
      console.error(`[api] 推送处理失败 (${channel})`, err)
    }
  })
}

/** 任意异常 → 可展示的中文文案（ErrorState / toast 用） */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message || err.codeLabel
  if (err instanceof Error) return err.message || '发生了未知错误'
  if (typeof err === 'string' && err.trim()) return err
  return '发生了未知错误'
}

/** 取错误码；非 ApiError 返回 'UNKNOWN'。`code === 'NO_API_KEY'` 常用于引导去设置页 */
export function errorCode(err: unknown): ErrorCode {
  return err instanceof ApiError ? err.code : 'UNKNOWN'
}
