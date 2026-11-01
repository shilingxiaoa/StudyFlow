/**
 * 费曼复述评分。
 * 关键点：模型只输出各维度 0–1 的达成度，分数一定由主进程按契约权重折算
 * （accuracy 18 / coverage 12 / example 10 / clarity 6，合计 50），避免模型算术飘。
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
  /** 0–50，主进程折算 */
  score: number
  /** ≤120 字 */
  feedback: string
  /** ≤40 字 */
  criticalGap: string
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(value, 0), 1)
}

/** 维度达成度 → 50 分制（权重来自 contracts.SCORING，禁止在别处另写一份） */
export function scoreFromDimensions(dimensions: RecitationDimensions): number {
  const weights = SCORING.recitationWeights
  const raw =
    clamp01(dimensions.accuracy) * weights.accuracy +
    clamp01(dimensions.coverage) * weights.coverage +
    clamp01(dimensions.example) * weights.example +
    clamp01(dimensions.clarity) * weights.clarity
  return Math.min(Math.max(Math.round(raw), 0), SCORING.recitationTotal)
}

function cleanText(input: unknown, max: number): string {
  return String(input ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
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
  const feedback = cleanText(ai.feedback, 120)
  const criticalGap = cleanText(ai.critical_gap, 40)

  if (feedback === '' && criticalGap === '') {
    throw new AppError('AI_BAD_OUTPUT', 'AI 返回的评分是空的，请重试')
  }

  return {
    dimensions,
    score: scoreFromDimensions(dimensions),
    feedback: feedback === '' ? '讲解整体成型，继续在这种「讲给外行」的方式上打磨。' : feedback,
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
    parts.push(gap ? `复述里的「${gap}」还可以再打磨，明天学新内容前花 2 分钟回顾一下。` : '讲解到位，明天继续按计划推进。')
    return parts.join('')
  }

  if (input.totalScore >= SCORING.partialLine) {
    parts.push(`第 ${input.dayIndex} 天部分通过（总分 ${input.totalScore}，≥${SCORING.partialLine} 但未到 ${SCORING.passLine}）。`)
    parts.push(gap ? `先重看「${gap}」，再给一个自己的例子，重考把复述分补上去。` : '把复述再讲一遍、补一个自己的例子，重考即可。')
    return parts.join('')
  }

  parts.push(`第 ${input.dayIndex} 天没通过（总分 ${input.totalScore}）。`)
  if (input.objectiveScore < SCORING.objectiveTotal) {
    parts.push(`客观题丢了 ${SCORING.objectiveTotal - input.objectiveScore} 分，回去核对一下易混点。`)
  }
  parts.push(gap ? `重点补「${gap}」：先讲清定义，再讲因果，最后举一个自己的例子。` : '回到今天的任务重学一遍，再讲给外行听一次。')
  return parts.join('')
}
