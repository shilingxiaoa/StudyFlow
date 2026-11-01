/**
 * 问答环节评分。
 * 关键点：模型只输出各维度 0–1 的达成度，分数一定由主进程按契约权重折算
 * （accuracy 20 / coverage 10 / example 6 / clarity 4，合计 40），避免模型算术飘。
 */
import { SCORING } from '../../shared/contracts'
import type { DayDetail, RecitationDimensions, RecitationView } from '../../shared/contracts'
import { AppError } from '../ipc/handle'
import { EXAM_TIMEOUT_MS, responsesJSON } from './client'
import { GRADE_SCHEMA } from './schemas'
import type { GradeAi } from './schemas'
import { buildGradeSystem, buildGradeUser } from './prompts'

export interface RecitationGrade {
  dimensions: RecitationDimensions
  /** 0–40，主进程折算 */
  score: number
  /** 完整句子的点评，默认不超过 300 字 */
  feedback: string
  /** 完整句子，默认不超过 80 字 */
  criticalGap: string
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(value, 0), 1)
}

const FEEDBACK_MAX_CHARS = SCORING.feedbackMaxChars
const CRITICAL_GAP_MAX_CHARS = SCORING.criticalGapMaxChars

/** 维度达成度 → 40 分制（权重来自 contracts.SCORING，禁止在别处另写一份） */
export function scoreFromDimensions(dimensions: RecitationDimensions): number {
  const weights = SCORING.recitationWeights
  const raw =
    clamp01(dimensions.accuracy) * weights.accuracy +
    clamp01(dimensions.coverage) * weights.coverage +
    clamp01(dimensions.example) * weights.example +
    clamp01(dimensions.clarity) * weights.clarity
  return Math.min(Math.max(Math.round(raw), 0), SCORING.recitationTotal)
}

/**
 * 规范化文本：合并空白，超长时按句子边界截断（绝不切在半句上）。
 * 上限只用于兜底，正常由 prompt 控制长度。
 */
function cleanText(input: unknown, max: number): string {
  const text = String(input ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= max) return text

  const cut = text.slice(0, max)
  const sentence = Math.max(
    cut.lastIndexOf('。'),
    cut.lastIndexOf('！'),
    cut.lastIndexOf('？'),
    cut.lastIndexOf('；'),
    cut.lastIndexOf('!'),
    cut.lastIndexOf('?'),
    cut.lastIndexOf('.')
  )
  if (sentence >= max * 0.5) return cut.slice(0, sentence + 1)

  const clause = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('、'), cut.lastIndexOf(','))
  if (clause >= max * 0.5) return `${cut.slice(0, clause)}…`
  return `${cut}…`
}

/** 调 AI 评分 + 本地折算 */
export async function gradeRecitation(
  input: {
    day: Pick<DayDetail, 'index' | 'title' | 'goal' | 'checkpoints'>
    recitation: Pick<RecitationView, 'prompt' | 'followUp' | 'messages'>
    keyPoints: readonly string[]
    timeoutMs?: number
  }
): Promise<RecitationGrade> {
  const ai = await responsesJSON<GradeAi>({
    scene: 'recitation',
    system: buildGradeSystem(),
    user: buildGradeUser({
      day: input.day,
      recitation: input.recitation,
      keyPoints: input.keyPoints
    }),
    schema: GRADE_SCHEMA,
    timeoutMs: input.timeoutMs ?? EXAM_TIMEOUT_MS
  })

  const dimensions: RecitationDimensions = {
    accuracy: clamp01(ai.dimensions.accuracy),
    coverage: clamp01(ai.dimensions.coverage),
    example: clamp01(ai.dimensions.example),
    clarity: clamp01(ai.dimensions.clarity)
  }
  const feedback = cleanText(ai.feedback, FEEDBACK_MAX_CHARS)
  const criticalGap = cleanText(ai.critical_gap, CRITICAL_GAP_MAX_CHARS)

  if (feedback === '' && criticalGap === '') {
    throw new AppError('AI_BAD_OUTPUT', 'AI 返回的评分是空的，请重试')
  }

  return {
    dimensions,
    score: scoreFromDimensions(dimensions),
    feedback: feedback === '' ? '回答基本对路，继续按这种「说清因果」的方式答题。' : feedback,
    criticalGap: criticalGap === '' ? '个别要点还没讲透' : criticalGap
  }
}

export interface AdviceInput {
  dayIndex: number
  totalScore: number
  objectiveScore: number
  recitationScore: number
  passed: boolean
  criticalGap: string | null
}

/** 结算后的下一步建议（本地拼文案，不再额外花 token） */
export function buildAdvice(input: AdviceInput): string {
  const parts: string[] = []
  const gap = input.criticalGap && input.criticalGap.trim() !== '' ? input.criticalGap.trim() : null

  if (input.passed) {
    parts.push(`第 ${input.dayIndex} 天通过（总分 ${input.totalScore}）。`)
    parts.push(gap ? `问答里「${gap}」还可以再补一句，明天学新内容前花 2 分钟回顾一下。` : '问答答得到位，明天继续按计划推进。')
    return parts.join('')
  }

  if (input.totalScore >= SCORING.partialLine) {
    parts.push(`第 ${input.dayIndex} 天部分通过（总分 ${input.totalScore}，≥${SCORING.partialLine} 但未到 ${SCORING.passLine}）。`)
    parts.push(gap ? `先重看「${gap}」，下次问到同类问题能直接说清因果，重考把问答分补上去。` : '把这两天的问题再答一遍（说清因果就行），重考即可。')
    return parts.join('')
  }

  parts.push(`第 ${input.dayIndex} 天没通过（总分 ${input.totalScore}）。`)
  if (input.objectiveScore < SCORING.objectiveTotal) {
    parts.push(`客观题丢了 ${SCORING.objectiveTotal - input.objectiveScore} 分，回去核对一下易混点。`)
  }
  parts.push(gap ? `重点补「${gap}」：先弄清定义，再说清因果。` : '回到今天的任务重学一遍，再来答一次。')
  return parts.join('')
}
