/**
 * 费曼追问：AI 扮演「真的没学过、爱较真的学生」，听完讲解只问 1 个问题。
 * 这里是最后一道闸：清掉模型偶尔带出来的提示/答案、只保留 1 个问号、控制在 80 字内。
 */
import type { DayDetail } from '../../shared/contracts'
import { AppError } from '../ipc/handle'
import { FOLLOWUP_TIMEOUT_MS, chatText } from './client'
import { buildFeynmanSystem, buildFollowUpUser } from './prompts'

const MAX_FOLLOWUP_CHARS = 80

/** 模型容易加的壳：markdown、引号、角色前缀、多余的提示行 */
export function sanitizeFollowUp(raw: string): string {
  let text = String(raw ?? '').trim()

  // 去掉代码块 / markdown 强调
  text = text.replace(/```[a-zA-Z]*/g, '').replace(/\*\*/g, '').trim()
  // 去掉「学生：」「追问：」这类前缀
  text = text.replace(/^(?:学生|学生问|追问|问题|我|A)[\s]*[:：]\s*/i, '').trim()
  // 去掉模型偷偷附带的提示/答案行
  text = text
    .split(/\r?\n/)
    .filter((line) => !/^(?:提示|答案|解析|知识点|参考答案)\s*[:：]/.test(line.trim()))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  // 去掉整体包裹的引号
  if (/^[「『“"'].*[」』”"']$/.test(text) && Array.from(text).length > 2) {
    text = text.slice(1, -1).trim()
  }

  if (text === '') return ''

  // 只保留第一个问句
  const firstQuestion = text.search(/[？?]/)
  if (firstQuestion >= 0) {
    text = text.slice(0, firstQuestion + 1)
  } else {
    text = `${text}？`
  }

  // 超长就在 78 字处截断并补问号
  const chars = Array.from(text)
  if (chars.length > MAX_FOLLOWUP_CHARS) {
    text = `${chars.slice(0, MAX_FOLLOWUP_CHARS - 2).join('').replace(/[，,、；;：:]+$/, '')}？`
  }

  return text.trim()
}

export interface FollowUpInput {
  day: Pick<DayDetail, 'index' | 'title' | 'goal' | 'checkpoints'>
  topicPrompt: string
  explainText: string
  keyPoints: readonly string[]
  timeoutMs?: number
}

/** 调 AI 生成 1 个追问 */
export async function generateFollowUp(input: FollowUpInput): Promise<string> {
  const raw = await chatText({
    scene: 'recitation',
    system: buildFeynmanSystem(),
    user: buildFollowUpUser({
      day: input.day,
      topicPrompt: input.topicPrompt,
      explainText: input.explainText,
      keyPoints: input.keyPoints
    }),
    timeoutMs: input.timeoutMs ?? FOLLOWUP_TIMEOUT_MS
  })

  const question = sanitizeFollowUp(raw)
  if (question === '') {
    throw new AppError('AI_BAD_OUTPUT', 'AI 没有生成有效的追问，请重试')
  }
  return question
}
