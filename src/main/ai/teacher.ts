/**
 * 每日教案：把「读教材第 1 节」这种空任务变成能照着学的一课。
 * 结构：overview → sections（Markdown 讲解）→ practices（做题）→ guides（每个任务的具体步骤）
 *       → misconceptions（常见坑）→ selfCheck（自检问题）。
 * AI 输出在这里整形：字段清洗、长度下限、guides 与任务标题对齐。
 */
import type { DayDetail, Goal, Lesson, Material } from '../../shared/contracts'
import { AppError } from '../ipc/handle'
import { chatText, responsesJSON } from './client'
import { LESSON_SCHEMA } from './schemas'
import type { LessonAi } from './schemas'
import type { LessonPayload } from '../db/repo'
import {
  buildAskSystem,
  buildAskUser,
  buildLessonSystem,
  buildLessonUser
} from './prompts'

const LESSON_TIMEOUT_MS = 150_000
const ASK_TIMEOUT_MS = 60_000

const MIN_SECTIONS = 2
const MAX_SECTIONS = 6
const MIN_SECTION_BODY = 40
const MIN_PRACTICES = 2
const MAX_PRACTICES = 5
const MAX_GUIDE_STEPS = 6
const MAX_TEXTS = 6

function text(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max)
}

function clampMinutes(value: unknown, fallback: number): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(Math.max(Math.round(num), 3), 60)
}

function uniqueTexts(values: readonly unknown[], max: number, maxChars: number): string[] {
  const result: string[] = []
  for (const value of values ?? []) {
    const item = text(value, maxChars)
    if (item !== '' && !result.includes(item)) result.push(item)
    if (result.length >= max) break
  }
  return result
}

/** 把 AI 返回的教案整形为可入库的 LessonPayload */
export function normalizeLesson(ai: LessonAi, day: DayDetail): LessonPayload {
  const sections = (ai.sections ?? [])
    .map((section) => ({
      title: text(section.title, 40) || '讲解',
      minutes: clampMinutes(section.minutes, 10),
      body: text(section.body, 4000)
    }))
    .filter((section) => section.body.length >= MIN_SECTION_BODY)
    .slice(0, MAX_SECTIONS)

  if (sections.length < MIN_SECTIONS) {
    throw new AppError('AI_BAD_OUTPUT', 'AI 生成的教案内容太少（讲解不完整），请重试')
  }

  const practices = (ai.practices ?? [])
    .map((practice) => {
      const kind: Lesson['practices'][number]['kind'] =
        practice.kind === 'recall' || practice.kind === 'apply' ? practice.kind : 'exercise'
      return {
        kind,
        prompt: text(practice.prompt, 400),
        answer: text(practice.answer, 1200),
        hint: text(practice.hint, 200)
      }
    })
    .filter((practice) => practice.prompt !== '' && practice.answer !== '')
    .slice(0, MAX_PRACTICES)

  if (practices.length < MIN_PRACTICES) {
    throw new AppError('AI_BAD_OUTPUT', 'AI 没有给出足够的练习题，请重试')
  }

  // guides 与真实任务对齐：先按标题精确匹配，对不上就按顺序兜底
  const taskTitles = day.tasks.map((task) => task.title)
  const rawGuides = (ai.guides ?? []).map((guide) => ({
    taskTitle: text(guide.taskTitle, 80),
    steps: uniqueTexts(guide.steps, MAX_GUIDE_STEPS, 200)
  }))
  const guides = taskTitles.map((title, index) => {
    const matched = rawGuides.find((guide) => guide.taskTitle === title)
    const positional = rawGuides[index]
    const source = matched ?? positional
    return {
      taskTitle: title,
      steps: source && source.steps.length > 0 ? source.steps : []
    }
  })

  return {
    title: text(ai.title, 60) || day.title,
    overview: text(ai.overview, 200) || day.goal,
    sections,
    practices,
    guides: guides.filter((guide) => guide.steps.length > 0),
    misconceptions: uniqueTexts(ai.misconceptions, 4, 200),
    selfCheck: uniqueTexts(ai.selfCheck, MAX_TEXTS, 120)
  }
}

export interface GenerateLessonInput {
  goal: Goal
  day: DayDetail
  materials: readonly Material[]
  timeoutMs?: number
}

/** 为一天生成教案（不落库，落库由调用方负责） */
export async function generateLesson(input: GenerateLessonInput): Promise<LessonPayload> {
  const ai = await responsesJSON<LessonAi>({
    scene: 'lesson',
    system: buildLessonSystem(),
    user: buildLessonUser({ goal: input.goal, day: input.day, materials: input.materials }),
    schema: LESSON_SCHEMA,
    timeoutMs: input.timeoutMs ?? LESSON_TIMEOUT_MS,
    maxOutputTokens: 12_000
  })
  return normalizeLesson(ai, input.day)
}

export interface AskLessonInput {
  goalTitle: string
  dayTitle: string
  lesson: Lesson
  materials: readonly Material[]
  question: string
  timeoutMs?: number
}

function materialExcerpt(materials: readonly Material[], limit = 2_400): string {
  const usable = materials.filter((item) => item.content.trim() !== '').slice(0, 2)
  return usable
    .map((item) => `《${item.title || '资料'}》\n${item.content.slice(0, 2_000)}`)
    .join('\n\n')
    .slice(0, limit)
}

/** 上课时的答疑：带讲义与资料上下文回答，纯文本返回 */
export async function askLesson(input: AskLessonInput): Promise<string> {
  const answer = await chatText({
    scene: 'ask',
    system: buildAskSystem(),
    user: buildAskUser({
      goalTitle: input.goalTitle,
      dayTitle: input.dayTitle,
      lessonTitle: input.lesson.title,
      sectionTitles: input.lesson.sections.map((section) => section.title),
      materialExcerpt: materialExcerpt(input.materials),
      question: input.question
    }),
    timeoutMs: input.timeoutMs ?? ASK_TIMEOUT_MS
  })
  const text = String(answer ?? '').trim()
  if (text === '') {
    throw new AppError('AI_BAD_OUTPUT', 'AI 没有给出回答，请再问一次')
  }
  return text.slice(0, 2_000)
}
