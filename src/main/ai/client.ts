/**
 * DeepSeek 接入层：三条通道 + 统一的重试 / 超时 / 错误翻译 / 用量记账。
 *
 *  · responsesJSON ——/responses + text.format(json_schema, strict)  用于计划、出题、评分
 *  · chatJSON     ——/chat/completions + response_format json_object 用于需要快速跑完的结构化小任务
 *  · chatText     ——/chat/completions 纯文本（费曼追问，thinking 关闭，失败自动回退不传）
 *
 * 注意：思考模式下 temperature 无效，本文件一律不传。
 */
import { AppError } from '../ipc/handle'
import { PUSH } from '../../shared/contracts'
import type { AiStage } from '../../shared/contracts'
import { getApiKey, getSettings, logAiUsage } from '../db/repo'
import { broadcast } from '../db/bus'
import { logger } from '../util/logger'
import type { StructuredOutputSchema } from './schemas'
import { SchemaValidationError } from './schemas'

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
export const AI_MODEL = 'deepseek-flash'

/** 一次调用落在哪个业务场景（写进 ai_usage.scene） */
export type AiScene = 'plan' | 'exam' | 'recitation' | 'review' | 'lesson' | 'ask'

const DEFAULT_TIMEOUT_MS = 120_000
/** 费曼追问要快：45s 足够，超时就重来 */
export const FOLLOWUP_TIMEOUT_MS = 45_000
/** 30 天计划输出长，给足时间（文档 4.1 口径 180s） */
export const PLAN_TIMEOUT_MS = 180_000
/** 出题 / 问答评分（文档 4.1 口径 120s） */
export const EXAM_TIMEOUT_MS = 120_000
const MAX_RETRIES = 3

/** 元 / 百万 token */
const PRICE_OUTPUT = 4
const PRICE_INPUT_MISS = 1
const PRICE_INPUT_HIT = 0.02

interface Usage {
  promptTokens: number
  completionTokens: number
  cacheHitTokens: number
}

/** 内部错误：status=null 表示网络层失败；timedOut 区分超时 */
class RequestFailure extends Error {
  readonly status: number | null
  readonly timedOut: boolean
  readonly retryAfterMs: number | null
  readonly detail: string
  constructor(status: number | null, timedOut: boolean, message: string, detail = '', retryAfterMs: number | null = null) {
    super(message)
    this.name = 'RequestFailure'
    this.status = status
    this.timedOut = timedOut
    this.detail = detail
    this.retryAfterMs = retryAfterMs
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readApiKey(): Promise<string> {
  const key = await getApiKey()
  const trimmed = (key ?? '').trim()
  if (trimmed === '') {
    throw new AppError('NO_API_KEY', '请先在设置里填写 DeepSeek API Key')
  }
  return trimmed
}

/** 主动检查是否有 Key（AI 通道入口先调一次，给出更早的错误提示） */
export async function assertApiKey(): Promise<string> {
  return readApiKey()
}

/** 设置里允许覆盖 Base URL（自建代理/镜像）；异常时退回官方地址 */
async function resolveBaseUrl(): Promise<string> {
  try {
    const settings = await getSettings()
    const base = (settings.baseUrl ?? '').trim()
    if (base !== '') return base.replace(/\/+$/, '')
  } catch {
    // 读配置失败不影响请求，用默认地址
  }
  return DEEPSEEK_BASE_URL
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 15_000)
  const at = Date.parse(value)
  if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), 15_000)
  return null
}

function failureMessage(status: number, detail: string): string {
  const head = `DeepSeek 返回 HTTP ${status}`
  const tail = detail.trim().slice(0, 300)
  return tail === '' ? head : `${head}：${tail}`
}

async function postJson(path: string, body: unknown, timeoutMs: number): Promise<{ text: string; latencyMs: number }> {
  const key = await readApiKey()
  const baseUrl = await resolveBaseUrl()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    let response: Response
    let text: string
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      text = await response.text()
    } catch (err) {
      const aborted = controller.signal.aborted
      const message = err instanceof Error ? err.message : String(err)
      throw new RequestFailure(null, aborted, aborted ? 'AI 请求超时' : 'AI 网络请求失败', message)
    }

    if (!response.ok) {
      throw new RequestFailure(
        response.status,
        false,
        failureMessage(response.status, text),
        text,
        parseRetryAfter(response.headers.get('retry-after'))
      )
    }
    return { text, latencyMs: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

function isRetryable(err: RequestFailure): boolean {
  if (err.timedOut) return false
  const status = err.status
  if (status === null) return false
  return status === 429 || status >= 500
}

async function postJsonWithRetry(path: string, body: unknown, timeoutMs: number): Promise<{ text: string; latencyMs: number }> {
  let attempt = 0
  for (;;) {
    try {
      return await postJson(path, body, timeoutMs)
    } catch (err) {
      if (!(err instanceof RequestFailure)) throw err
      if (!isRetryable(err) || attempt >= MAX_RETRIES) throw err
      const backoff = Math.min(600 * 2 ** attempt, 8_000)
      const wait = err.retryAfterMs ?? backoff
      attempt += 1
      logger.warn('ai', `请求失败（HTTP ${err.status ?? 'network'}），${wait}ms 后第 ${attempt} 次重试`)
      await sleep(wait)
    }
  }
}

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err
  if (err instanceof SchemaValidationError) {
    return new AppError('AI_BAD_OUTPUT', `AI 输出格式异常：${err.message}，请重试`)
  }
  if (err instanceof RequestFailure) {
    if (err.status === 401) return new AppError('INVALID_API_KEY', 'DeepSeek API Key 无效，请在设置里重新填写')
    if (err.status === 402) return new AppError('INSUFFICIENT_BALANCE', 'DeepSeek 账户余额不足，请充值后重试')
    if (err.status === 429) return new AppError('RATE_LIMITED', '请求太快了，请稍等几秒再试')
    if (err.timedOut) return new AppError('TIMEOUT', 'AI 响应超时，请重试')
    if (err.status === null) return new AppError('NETWORK', '网络连接失败，请检查网络或代理设置')
    if (err.status >= 500) return new AppError('UNKNOWN', 'DeepSeek 服务暂时不可用，请稍后重试')
    return new AppError('UNKNOWN', err.message)
  }
  const message = err instanceof Error ? err.message : String(err)
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed|socket hang up/i.test(message)) {
    return new AppError('NETWORK', '网络连接失败，请检查网络或代理设置')
  }
  return new AppError('UNKNOWN', message)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text)
    return asRecord(value)
  } catch {
    throw new AppError('AI_BAD_OUTPUT', 'AI 返回的内容不是合法 json，请重试')
  }
}

function pickUsage(json: Record<string, unknown>): Usage {
  const usage = asRecord(json.usage)
  const details = asRecord(usage.input_tokens_details ?? usage.prompt_tokens_details)
  const promptTokens = asNumber(usage.input_tokens ?? usage.prompt_tokens)
  const completionTokens = asNumber(usage.output_tokens ?? usage.completion_tokens)
  const cacheHitTokens = asNumber(
    usage.prompt_cache_hit_tokens ?? usage.cache_hit_tokens ?? details.cached_tokens
  )
  return { promptTokens, completionTokens, cacheHitTokens: Math.min(cacheHitTokens, promptTokens) }
}

function computeCost(usage: Usage | null): number {
  if (!usage) return 0
  const hit = Math.min(usage.cacheHitTokens, usage.promptTokens)
  const miss = Math.max(usage.promptTokens - hit, 0)
  const yuan =
    (miss * PRICE_INPUT_MISS + hit * PRICE_INPUT_HIT + usage.completionTokens * PRICE_OUTPUT) / 1_000_000
  return Math.round(yuan * 1_000_000) / 1_000_000
}

async function recordUsage(scene: AiScene, usage: Usage | null, ok: boolean, latencyMs: number): Promise<void> {
  try {
    await logAiUsage({
      scene,
      model: AI_MODEL,
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
      cacheHitTokens: usage?.cacheHitTokens ?? 0,
      cost: computeCost(usage),
      latencyMs,
      ok
    })
  } catch (err) {
    logger.warn('ai', '写入 ai_usage 失败', err)
  }
}

/** 长任务进度推送：渲染层据此显示「正在拆解 30 天计划…」之类文案 */
export function emitStage(scene: AiScene, stage: string, percent: number | null = null): void {
  const payload: AiStage = { scene, stage, percent }
  broadcast(PUSH.AI_STAGE, payload)
}

/** 从 /responses 的响应里拿纯文本：优先 output_text，否则拼 output[].content[] 里的 output_text */
function extractResponsesText(json: Record<string, unknown>): string {
  const direct = json.output_text
  if (typeof direct === 'string' && direct.trim() !== '') return direct

  const output = Array.isArray(json.output) ? json.output : []
  const parts: string[] = []
  for (const item of output) {
    const record = asRecord(item)
    if (typeof record.type === 'string' && record.type !== 'message') continue
    const content = Array.isArray(record.content) ? record.content : []
    for (const piece of content) {
      const part = asRecord(piece)
      if (part.type === 'output_text' && typeof part.text === 'string') {
        parts.push(part.text)
      } else if (part.type === 'text' && typeof part.text === 'string') {
        parts.push(part.text)
      }
    }
  }
  return parts.join('')
}

function extractChatText(json: Record<string, unknown>): { text: string; reasoning: string } {
  const choices = Array.isArray(json.choices) ? json.choices : []
  const first = asRecord(choices[0])
  const message = asRecord(first.message)
  const text = typeof message.content === 'string' ? message.content : ''
  const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : ''
  return { text, reasoning }
}

/** `status=incomplete` 时官方给出的原因：`max_output_tokens` 或 `content_filter` */
function incompleteReason(json: Record<string, unknown>): string | null {
  const details = asRecord(json.incomplete_details)
  const reason = details.reason
  return typeof reason === 'string' && reason !== '' ? reason : null
}

export interface ResponsesJSONOptions<T> {
  scene: AiScene
  system: string
  user: string
  schema: StructuredOutputSchema<T>
  timeoutMs?: number
  maxOutputTokens?: number
  /** 思考档位；结构化输出建议 none（默认），让预算全留给 JSON */
  effort?: 'none' | 'low' | 'high' | 'max'
}

/** Responses API + strict json_schema：生成计划 / 出题 / 评分 */
export async function responsesJSON<T>(opts: ResponsesJSONOptions<T>): Promise<T> {
  const started = Date.now()
  let usage: Usage | null = null
  let ok = false
  emitStage(opts.scene, '正在请求模型…')
  // 结构化输出场景默认关掉思考：思考 token 和 JSON 正文抢同一个 max_output_tokens 预算，
  // 预算被推理吃光时 API 会返回 status=incomplete 且 output 里只有 reasoning（表现为「没有返回结构化内容」）。
  const effort = opts.effort ?? 'none'
  const baseTokens = opts.maxOutputTokens ?? 8_000
  const maxAttempts = 2

  try {
    let lastError: unknown = null
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const maxOutputTokens = Math.min(baseTokens * (attempt + 1), 96_000)
      const body: Record<string, unknown> = {
        model: AI_MODEL,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: opts.system }] },
          { role: 'user', content: [{ type: 'input_text', text: opts.user }] }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: opts.schema.name,
            schema: opts.schema.schema,
            strict: true
          }
        },
        reasoning: { effort },
        max_output_tokens: maxOutputTokens,
        stream: false
      }

      try {
        const raw = await postJsonWithRetry('/responses', body, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
        const json = parseJsonObject(raw.text)
        usage = pickUsage(json)
        const text = extractResponsesText(json)
        const reason = incompleteReason(json)

        if (text.trim() === '') {
          logger.warn('ai', `[${opts.scene}] 第 ${attempt + 1} 次返回空正文`, {
            status: asRecord(json).status,
            reason,
            outputTypes: (Array.isArray(json.output) ? json.output : []).map(
              (item) => asRecord(item).type
            ),
            usage
          })
          if (reason === 'max_output_tokens') {
            lastError = new AppError(
              'AI_BAD_OUTPUT',
              '模型把输出预算用完了（思考过程太长），已自动重试仍失败：请减少资料份数或把目标写短一点'
            )
          } else if (reason === 'content_filter') {
            throw new AppError('AI_BAD_OUTPUT', '这次内容被模型的安全策略拦截了，换个说法或换份资料试试')
          } else {
            lastError = new AppError('AI_BAD_OUTPUT', 'AI 没有返回结构化内容，请重试')
          }
          continue
        }

        try {
          const parsed = opts.schema.parse(text)
          ok = true
          return parsed
        } catch (parseErr) {
          // 常见于 JSON 被截断：status=incomplete 时重试一次，预算翻倍
          logger.warn('ai', `[${opts.scene}] 第 ${attempt + 1} 次结构化解析失败`, {
            reason,
            textLength: text.length,
            textTail: text.slice(-200),
            error: parseErr instanceof Error ? parseErr.message.slice(0, 300) : String(parseErr)
          })
          lastError = parseErr
          if (reason !== 'max_output_tokens' && text.length < 50) continue
          if (reason !== 'max_output_tokens') break
        }
      } catch (err) {
        lastError = err
        if (err instanceof AppError && err.code === 'AI_BAD_OUTPUT') {
          // 内容被拦截 / 空正文且不是预算问题：重试意义不大，直接抛
          if (!/预算/.test(err.message)) throw err
        } else {
          break
        }
      }
    }
    throw lastError ?? new AppError('AI_BAD_OUTPUT', 'AI 没有返回结构化内容，请重试')
  } catch (err) {
    throw toAppError(err)
  } finally {
    emitStage(opts.scene, ok ? '完成' : '失败')
    await recordUsage(opts.scene, usage, ok, Date.now() - started)
  }
}

export interface ChatJSONOptions<T> {
  scene: AiScene
  system: string
  user: string
  schema: StructuredOutputSchema<T>
  timeoutMs?: number
  /** 解析失败时重试 1 次（默认开） */
  retryOnParseError?: boolean
}

/** Chat Completions + json_object：快速、便宜的结构化任务 */
export async function chatJSON<T>(opts: ChatJSONOptions<T>): Promise<T> {
  const started = Date.now()
  const usage: Usage = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0 }
  let ok = false
  emitStage(opts.scene, '正在请求模型…')

  const system = /json/i.test(`${opts.system}\n${opts.user}`) ? opts.system : `${opts.system}\n只输出 json。`
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [
    { role: 'system', content: system },
    { role: 'user', content: opts.user }
  ]
  const maxAttempts = opts.retryOnParseError === false ? 1 : 2

  try {
    let lastError: unknown = null
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const raw = await postJsonWithRetry(
        '/chat/completions',
        { model: AI_MODEL, messages, response_format: { type: 'json_object' }, stream: false },
        opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      )
      const json = parseJsonObject(raw.text)
      const collected = pickUsage(json)
      usage.promptTokens += collected.promptTokens
      usage.completionTokens += collected.completionTokens
      usage.cacheHitTokens += collected.cacheHitTokens
      const { text, reasoning } = extractChatText(json)
      if (reasoning !== '') logger.info('ai', `[${opts.scene}] reasoning: ${reasoning.slice(0, 200)}`)
      if (text.trim() === '') {
        lastError = new AppError('AI_BAD_OUTPUT', 'AI 返回了空内容，请重试')
        continue
      }
      try {
        const parsed = opts.schema.parse(text)
        ok = true
        return parsed
      } catch (err) {
        lastError = err
        messages.push({ role: 'user', content: '上一次输出不是合法 json，请严格只输出一个满足要求的 json 对象，不要解释。' })
      }
    }
    throw lastError ?? new AppError('AI_BAD_OUTPUT', 'AI 没有返回可用内容，请重试')
  } catch (err) {
    throw toAppError(err)
  } finally {
    emitStage(opts.scene, ok ? '完成' : '失败')
    await recordUsage(opts.scene, usage, ok, Date.now() - started)
  }
}

export interface ChatTextOptions {
  scene: AiScene
  system: string
  user: string
  timeoutMs?: number
}

/** Chat Completions 纯文本：费曼追问。thinking 关闭，接口不认这个字段时自动回退再发一次 */
export async function chatText(opts: ChatTextOptions): Promise<string> {
  const started = Date.now()
  let usage: Usage = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0 }
  let ok = false
  emitStage(opts.scene, '正在请求模型…')
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const messages = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user }
  ]

  const send = async (withThinking: boolean): Promise<string> => {
    const body: Record<string, unknown> = { model: AI_MODEL, messages, stream: false }
    if (withThinking) body.thinking = { type: 'disabled' }
    const raw = await postJsonWithRetry('/chat/completions', body, timeoutMs)
    const json = parseJsonObject(raw.text)
    const collected = pickUsage(json)
    usage = {
      promptTokens: usage.promptTokens + collected.promptTokens,
      completionTokens: usage.completionTokens + collected.completionTokens,
      cacheHitTokens: usage.cacheHitTokens + collected.cacheHitTokens
    }
    const { text, reasoning } = extractChatText(json)
    if (reasoning !== '') logger.info('ai', `[${opts.scene}] reasoning: ${reasoning.slice(0, 200)}`)
    return text
  }

  try {
    let text: string
    try {
      text = await send(true)
    } catch (err) {
      if (err instanceof RequestFailure && err.status !== null && err.status >= 400 && err.status < 500 && ![401, 402, 429].includes(err.status)) {
        logger.warn('ai', `thinking 关闭参数被拒（HTTP ${err.status}），回退为不传 thinking 重试`)
        text = await send(false)
      } else {
        throw err
      }
    }
    if (text.trim() === '') throw new AppError('AI_BAD_OUTPUT', 'AI 没有返回追问内容，请重试')
    ok = true
    return text.trim()
  } catch (err) {
    throw toAppError(err)
  } finally {
    emitStage(opts.scene, ok ? '完成' : '失败')
    await recordUsage(opts.scene, usage, ok, Date.now() - started)
  }
}

/** settings:testApiKey 用：最小请求验证 Key 是否可用 */
export async function testApiKey(): Promise<{ ok: true; latencyMs: number }> {
  const started = Date.now()
  let usage: Usage | null = null
  let ok = false
  try {
    const raw = await postJsonWithRetry(
      '/chat/completions',
      {
        model: AI_MODEL,
        messages: [{ role: 'user', content: '回复 ok 即可' }],
        max_tokens: 8,
        stream: false
      },
      30_000
    )
    const json = parseJsonObject(raw.text)
    usage = pickUsage(json)
    ok = true
    return { ok: true, latencyMs: Date.now() - started }
  } catch (err) {
    throw toAppError(err)
  } finally {
    // 校验 Key 的极小请求也记账；scene 用 'settings' 便于统计里区分
    await recordUsage('settings' as AiScene, usage, ok, Date.now() - started)
  }
}
