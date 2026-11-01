/**
 * 客观题本地判分（不花 token）。
 *  · 单选：比较下标（0 起），同时兼容前端传 1 起数字 / 字母 / 选项原文
 *  · 填空：normalize（去空白 + 全角转半角 + 大小写）后与 answer / answerAliases 精确比较
 */
import type { Question } from '../../shared/contracts'

/** 全角字符转半角（U+FF01-FF5E → U+0021-007E，全角空格 → 半角空格） */
export function toHalfWidth(input: string): string {
  let out = ''
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0x3000) out += ' '
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0)
    else out += ch
  }
  return out
}

/** 判分口径：去所有空白、全角转半角、小写、去掉首尾标点 */
export function normalizeAnswer(input: unknown): string {
  if (input === null || input === undefined) return ''
  const raw = toHalfWidth(String(input))
  return raw
    .replace(/[\s\u00a0\u3000]+/g, '')
    .toLowerCase()
    .replace(/^[.,;:!?'"]+|[.,;:!?'"]+$/g, '')
}

function stripListPrefix(text: string): string {
  // "1. xxx" / "A、xxx" / "（2）xxx" 这类前缀去掉
  return text.replace(/^\s*(?:[0-9]{1,2}|[a-zA-Z])\s*[.、,)）:：]\s*/, '').trim()
}

/** 把用户/模型给的选择题答案解析成 0 起下标；解析不出来返回 null */
export function resolveChoiceIndex(raw: unknown, options: string[] | null | undefined): number | null {
  const opts = Array.isArray(options) ? options : []
  const size = opts.length
  const text = normalizeAnswer(raw)
  if (!text) return null

  if (/^\d+$/.test(text)) {
    const n = Number(text)
    if (size > 0) {
      if (n >= 0 && n < size) return n
      if (n >= 1 && n <= size) return n - 1
    }
    return n >= 0 ? n : null
  }

  if (/^[a-z]$/.test(text)) return text.charCodeAt(0) - 97

  for (let i = 0; i < size; i += 1) {
    const opt = normalizeAnswer(stripListPrefix(opts[i]))
    if (opt && (opt === text || stripListPrefix(opts[i]) === String(raw).trim())) return i
  }
  for (let i = 0; i < size; i += 1) {
    const opt = normalizeAnswer(stripListPrefix(opts[i]))
    if (opt && text.length >= 2 && (opt.includes(text) || text.includes(opt))) return i
  }
  return null
}

/** 填空题是否命中标准答案或任一等价写法 */
export function matchBlank(raw: unknown, answer: string, aliases: readonly string[]): boolean {
  const user = normalizeAnswer(raw)
  if (!user) return false
  const candidates = [answer, ...aliases].map((v) => normalizeAnswer(v)).filter((v) => v.length > 0)
  return candidates.some((c) => c === user)
}

export interface JudgeResult {
  correct: boolean
  userAnswer: string
}

/** 判一道客观题 */
export function judgeQuestion(question: Question, raw: unknown): JudgeResult {
  const userAnswer = raw === null || raw === undefined ? '' : String(raw)
  if (question.type === 'single_choice') {
    const picked = resolveChoiceIndex(raw, question.options)
    const expected = resolveChoiceIndex(question.answer, question.options)
    return { correct: picked !== null && expected !== null && picked === expected, userAnswer }
  }
  return { correct: matchBlank(raw, question.answer, question.answerAliases ?? []), userAnswer }
}

/**
 * 从各种前端入参形状里抽出 { questionId -> 用户答案 }：
 *  1) { [questionId]: 'answer' }
 *  2) [{ questionId|id, answer|value }]
 *  3) { answers: 上面任意一种 }
 * 若无 id，则按题目在列表中的下标（0 起或 1 起都兼容）映射。
 */
export function extractAnswerMap(
  payload: unknown,
  questions: readonly { id: string }[]
): Map<string, string> {
  const map = new Map<string, string>()
  const put = (key: unknown, value: unknown): void => {
    const id = String(key ?? '').trim()
    if (!id) return
    map.set(id, value === null || value === undefined ? '' : String(value))
  }

  const source = (payload as { answers?: unknown } | null)?.answers ?? payload

  if (Array.isArray(source)) {
    source.forEach((item, index) => {
      if (!item || typeof item !== 'object') {
        const q = questions[index]
        if (q) put(q.id, item)
        return
      }
      const rec = item as Record<string, unknown>
      const id = rec.questionId ?? rec.question_id ?? rec.id ?? rec.qid
      const value = rec.answer ?? rec.value ?? rec.userAnswer ?? rec.user_answer ?? ''
      if (id !== undefined && id !== null) put(id, value)
      else {
        const q = questions[index]
        if (q) put(q.id, value)
      }
    })
    return map
  }

  if (source && typeof source === 'object') {
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (value !== null && typeof value === 'object') {
        const rec = value as Record<string, unknown>
        const inner = rec.answer ?? rec.value ?? rec.userAnswer ?? rec.user_answer
        if (inner !== undefined) {
          put(key, inner)
          continue
        }
      }
      put(key, value)
    }
  }
  return map
}

/** 中文场景下按码点数长度统计字符数 */
export function charCount(text: string): number {
  return Array.from(text).length
}
