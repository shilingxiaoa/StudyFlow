/**
 * 生成计划：goal（+ 资料）→ GeneratedPlan（约 30 天，每天 3–5 个任务）。
 * AI 的输出在这里做「落地前的整形」：天数、任务数、检查点数量、分钟数配平。
 */
import type { GeneratedDay, GeneratedPlan, Goal, Material } from '../../shared/contracts'
import { AppError } from '../ipc/handle'
import { PLAN_TIMEOUT_MS, responsesJSON } from './client'
import { PLAN_SCHEMA } from './schemas'
import type { PlanAi, PlanDayAi } from './schemas'
import { buildPlanSystem, buildPlanUser } from './prompts'

const MAX_DAYS = 45
const MIN_DAYS = 7
const MIN_TASK_MINUTES = 5
const MAX_TASK_MINUTES = 240

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}

function roundTo5(value: number): number {
  return Math.max(MIN_TASK_MINUTES, Math.round(value / 5) * 5)
}

/** 把一天的分钟数按 AI 给的比例分配到各任务上，保证求和 ≈ target */
function balanceTaskMinutes(rawMinutes: readonly number[], target: number): number[] {
  if (rawMinutes.length === 0) return []
  const weights = rawMinutes.map((value) => clampNumber(value, MIN_TASK_MINUTES, MAX_TASK_MINUTES))
  const totalWeight = weights.reduce((sum, value) => sum + value, 0)
  const goal = clampNumber(target, MIN_TASK_MINUTES * weights.length, MAX_TASK_MINUTES * weights.length)

  const result = weights.map((value) => roundTo5((value / totalWeight) * goal))
  let diff = goal - result.reduce((sum, value) => sum + value, 0)

  // 差额补到最长的那个任务上；若还不够，就轮流加 5 分钟
  let guard = 0
  while (diff !== 0 && guard < 200) {
    guard += 1
    const step = diff > 0 ? 5 : -5
    const index = result.indexOf(Math.max(...result))
    const next = result[index] + step
    if (next < MIN_TASK_MINUTES || next > MAX_TASK_MINUTES) {
      // 该任务已到边界：找下一个可调整的任务
      const alternative = result.findIndex(
        (value) => (step > 0 && value < MAX_TASK_MINUTES) || (step < 0 && value > MIN_TASK_MINUTES)
      )
      if (alternative < 0) break
      result[alternative] += step
    } else {
      result[index] = next
    }
    diff = goal - result.reduce((sum, value) => sum + value, 0)
  }
  return result
}

function normalizeCheckpoints(day: PlanDayAi, title: string, goalText: string): string[] {
  const unique: string[] = []
  for (const item of day.checkpoints ?? []) {
    const text = String(item ?? '').trim()
    if (text !== '' && !unique.includes(text)) unique.push(text.slice(0, 80))
  }
  const fallbackGoal = goalText !== '' ? goalText : title
  if (unique.length < 2) {
    unique.push(`能用自己的话讲清：${fallbackGoal}`)
  }
  if (unique.length < 2) {
    unique.push('今天的任务全部完成，且能说出今天学的 3 个关键词')
  }
  return unique.slice(0, 4)
}

function normalizeDay(day: PlanDayAi, index: number, dailyMinutes: number): GeneratedDay {
  const title = String(day.title ?? '').trim() || `第 ${index} 天学习`
  const goalText = String(day.goal ?? '').trim()

  const rawTasks = (day.tasks ?? []).filter((task) => String(task.title ?? '').trim() !== '')
  const tasks = rawTasks.slice(0, 5)
  if (tasks.length === 0) {
    tasks.push({ title: `精读并整理「${title}」的核心概念`, kind: 'read', estMinutes: Math.min(dailyMinutes, 60) })
  }
  if (tasks.length < 3) {
    // 少于 3 个任务时补一条自测任务，避免一天只有一个大块
    tasks.push({ title: '用 3 句话回答今天的自检问题并记录疑问', kind: 'review', estMinutes: 15 })
  }

  const minutes = balanceTaskMinutes(
    tasks.map((task) => Number(task.estMinutes)),
    dailyMinutes
  )

  return {
    index,
    title: title.slice(0, 40),
    goal: goalText.slice(0, 120),
    estMinutes: minutes.reduce((sum, value) => sum + value, 0),
    checkpoints: normalizeCheckpoints(day, title, goalText),
    tasks: tasks.map((task, taskIndex) => ({
      title: String(task.title).trim().slice(0, 60),
      kind: task.kind,
      estMinutes: minutes[taskIndex] ?? MIN_TASK_MINUTES
    }))
  }
}

/** 把模型输出整形为严格符合契约的 GeneratedPlan */
export function normalizePlan(ai: PlanAi, dailyMinutes: number): GeneratedPlan {
  const rawDays = ai.days ?? []
  if (rawDays.length === 0) {
    throw new AppError('AI_BAD_OUTPUT', 'AI 没有生成任何学习日，请重试')
  }
  if (rawDays.length < MIN_DAYS) {
    throw new AppError('AI_BAD_OUTPUT', `AI 只生成了 ${rawDays.length} 天计划，太短了，请重试`)
  }

  const target = clampNumber(Math.round(dailyMinutes), 20, 600)
  const days = rawDays.slice(0, MAX_DAYS).map((day, position) => normalizeDay(day, position + 1, target))

  const title = String(ai.title ?? '').trim() || '学习计划'
  const summary = String(ai.summary ?? '').trim()

  return {
    title: title.slice(0, 60),
    summary: summary.slice(0, 300),
    totalDays: days.length,
    days
  }
}

export interface GeneratePlanOptions {
  timeoutMs?: number
}

/** 调 AI 生成计划（入库由 plan:save 负责，生成不落库） */
export async function generatePlan(
  goal: Goal,
  materials: readonly Material[],
  options: GeneratePlanOptions = {}
): Promise<GeneratedPlan> {
  const ai = await responsesJSON<PlanAi>({
    scene: 'plan',
    system: buildPlanSystem(),
    user: buildPlanUser({ goal, materials }),
    schema: PLAN_SCHEMA,
    timeoutMs: options.timeoutMs ?? PLAN_TIMEOUT_MS,
    maxOutputTokens: 16_000
  })
  return normalizePlan(ai, goal.dailyMinutes)
}
