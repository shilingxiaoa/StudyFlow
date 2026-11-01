/**
 * 出题：给定一个 Day（含任务/检查点）→ 2 道单选 + 1 道填空 + 1 个问答（AI 提问，不是让人复述）。
 * AI 只负责「内容」，格式与合法性由这里把关；不合法就直接报 AI_BAD_OUTPUT 让用户重试，
 * 绝不把半成品写进数据库。
 */
import { SCORING } from '../../shared/contracts'
import type { DayDetail, QuestionType } from '../../shared/contracts'
import { AppError } from '../ipc/handle'
import { EXAM_TIMEOUT_MS, responsesJSON } from './client'
import { EXAM_SCHEMA } from './schemas'
import type { ExamAi, QuestionAi } from './schemas'
import { buildExamSystem, buildExamUser } from './prompts'
import type { QuestionInput } from '../db/repo'

export interface ExamDraft {
  questions: QuestionInput[]
  recitation: { prompt: string; keyPoints: string[] }
}

function cleanList(values: readonly unknown[] | null | undefined, max: number): string[] {
  const result: string[] = []
  for (const value of values ?? []) {
    const text = String(value ?? '').trim()
    if (text !== '' && !result.includes(text)) result.push(text)
    if (result.length >= max) break
  }
  return result
}

/** 把一道 AI 题整形为可入库的题；不可用返回 null */
function normalizeQuestion(raw: QuestionAi): QuestionInput | null {
  const stem = String(raw.stem ?? '').trim()
  if (stem === '') return null
  const knowledgePoint = String(raw.knowledgePoint ?? '').trim().slice(0, 60)
  const explanation = String(raw.explanation ?? '').trim().slice(0, 200)

  if (raw.type === 'single_choice') {
    const options = cleanList(raw.options, 6)
    if (options.length < 2) return null
    const expected = String(raw.answer ?? '').trim()
    const index = /^\d+$/.test(expected) ? Number(expected) : -1
    if (index < 0 || index >= options.length) return null
    return {
      type: 'single_choice',
      knowledgePoint,
      stem,
      options,
      answer: String(index),
      answerAliases: [],
      explanation,
      point: SCORING.objectivePerQuestion
    }
  }

  const answer = String(raw.answer ?? '').trim()
  if (answer === '') return null
  const aliases = cleanList(raw.answerAliases, 6).filter((alias) => alias !== answer)
  return {
    type: 'fill_blank',
    knowledgePoint,
    stem,
    options: null,
    answer,
    answerAliases: aliases,
    explanation,
    point: SCORING.objectivePerQuestion
  }
}

function fallbackRecitation(day: DayDetail): { prompt: string; keyPoints: string[] } {
  const focus = day.goal.trim() !== '' ? day.goal.trim() : day.title
  const points = cleanList(day.checkpoints, 3)
  return {
    prompt: `今天学了「${day.title}」。不用课本原话：${focus}为什么重要，什么情况下不成立？`,
    keyPoints: points.length > 0 ? points : [focus]
  }
}

/** 校验并整形一次出题结果：7 道单选 + 1 个问答 */
export function normalizeExam(ai: ExamAi, day: DayDetail): ExamDraft {
  const all = (ai.questions ?? []).map(normalizeQuestion).filter((q): q is QuestionInput => q !== null)
  const choices = all.filter((q) => q.type === 'single_choice')

  if (choices.length < SCORING.objectiveCount) {
    const types = (ai.questions ?? []).map((q) => q.type).join('/') || '空'
    throw new AppError(
      'AI_BAD_OUTPUT',
      `出题不符合要求（需要 ${SCORING.objectiveCount} 道单选，实际可用的只有 ${choices.length} 道；题型：${types}），请重试`
    )
  }

  const prompt = String(ai.recitation?.prompt ?? '').trim()
  const keyPoints = cleanList(ai.recitation?.keyPoints, 4)
  const fallback = fallbackRecitation(day)
  const recitation = {
    prompt: prompt === '' ? fallback.prompt : prompt,
    keyPoints: keyPoints.length > 0 ? keyPoints : fallback.keyPoints
  }

  return { questions: choices.slice(0, SCORING.objectiveCount), recitation }
}

/** 调 AI 出题（不落库，落库由 aiHandlers 负责） */
export async function generateExam(
  day: DayDetail,
  materialExcerpt: string,
  options: { timeoutMs?: number } = {}
): Promise<ExamDraft> {
  const ai = await responsesJSON<ExamAi>({
    scene: 'exam',
    system: buildExamSystem(),
    user: buildExamUser({ day, materialExcerpt }),
    schema: EXAM_SCHEMA,
    timeoutMs: options.timeoutMs ?? EXAM_TIMEOUT_MS
  })
  return normalizeExam(ai, day)
}

/** 题型合法性（给 handlers 复检用） */
export function isValidExamType(type: QuestionType): boolean {
  return type === 'single_choice' || type === 'fill_blank'
}
