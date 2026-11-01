/**
 * 数据访问层：所有 SQL、行↔契约对象映射、进度算法都在这里。
 *  · 每个导出函数开头都 await ensureReady()
 *  · 写操作结束后调用 persist()（防抖落盘）并推送 PUSH.* 事件
 *  · 返回值字段名严格对齐 src/shared/contracts.ts
 */
import { safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { API_BASE, MODEL_ID, PUSH, SCORING } from '../../shared/contracts'
import type {
  AppSettings,
  BootstrapData,
  ContextInput,
  DayDetail,
  DayStatus,
  DayWithTasks,
  Exam,
  ExamObjectiveResult,
  GeneratedPlan,
  Goal,
  GoalInput,
  GoalKind,
  GoalLevel,
  Lesson,
  LessonGuide,
  LessonPractice,
  LessonSection,
  Material,
  MaterialKind,
  Plan,
  PlanSummary,
  ProgressEvent,
  ProgressSummary,
  Question,
  QuestionType,
  RecitationDimensions,
  RecitationMessage,
  RecitationStatus,
  RecitationTask,
  RecitationView,
  StatsOverview,
  Task,
  TaskKind,
  TaskStatus
} from '../../shared/contracts'
import { AppError } from '../ipc/handle'
import { exportDir } from '../util/paths'
import { logger } from '../util/logger'
import { all, ensureReady, get, persist, run, transaction } from './database'
import type { Row } from './database'
import { broadcast } from './bus'
import { extractAnswerMap, judgeQuestion } from './answer'

// ───────────────────────────── 行读取小工具 ─────────────────────────────

function s(value: unknown, fallback = ''): string {
  if (value === undefined || value === null) return fallback
  return String(value)
}

function sOrNull(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  return String(value)
}

function n(value: unknown, fallback = 0): number {
  if (value === undefined || value === null || value === '') return fallback
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : fallback
}

function nOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

function b(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === '') return fallback
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num !== 0 : fallback
}

function jsonValue<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.trim() === '') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function stringList(value: unknown): string[] {
  const parsed = jsonValue<unknown>(value, [])
  if (!Array.isArray(parsed)) return []
  return parsed.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
}

function iso(date: Date = new Date()): string {
  return date.toISOString()
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function nowId(): string {
  return randomUUID()
}

function boolParam(value: boolean): number {
  return value ? 1 : 0
}

// ───────────────────────────── app_config ─────────────────────────────

function readConfig(key: string): string | null {
  const row = get<Row>('SELECT v FROM app_config WHERE k = ?', [key])
  return row ? sOrNull(row.v) : null
}

function writeConfig(key: string, value: string): void {
  run('INSERT OR REPLACE INTO app_config (k, v) VALUES (?, ?)', [key, value])
}

function deleteConfig(key: string): void {
  run('DELETE FROM app_config WHERE k = ?', [key])
}

function readConfigJson(key: string): unknown {
  const raw = readConfig(key)
  if (raw === null) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function writeConfigJson(key: string, value: unknown): void {
  writeConfig(key, JSON.stringify(value))
}

// ───────────────────────────── 当前选中的目标 / 计划 ─────────────────────────────
// 支持多目标、多计划：选择存在 app_config 里，重启后还停在同一个目标上。

const ACTIVE_GOAL_KEY = 'active_goal_id'
const ACTIVE_PLAN_KEY = 'active_plan_id'

function readActiveGoalId(): string | null {
  const value = (readConfig(ACTIVE_GOAL_KEY) ?? '').trim()
  return value === '' ? null : value
}

function readActivePlanId(): string | null {
  const value = (readConfig(ACTIVE_PLAN_KEY) ?? '').trim()
  return value === '' ? null : value
}

function writeActiveContext(goalId: string | null, planId: string | null): void {
  if (goalId === null || goalId === '') deleteConfig(ACTIVE_GOAL_KEY)
  else writeConfig(ACTIVE_GOAL_KEY, goalId)
  if (planId === null || planId === '') deleteConfig(ACTIVE_PLAN_KEY)
  else writeConfig(ACTIVE_PLAN_KEY, planId)
}

// ───────────────────────────── 设置 / API Key ─────────────────────────────

function readSettings(): AppSettings {
  const theme = readConfigJson('theme')
  const remindTime = readConfig('remind_time')
  const baseUrl = readConfig('base_url')
  return {
    hasApiKey: (readConfig('api_key') ?? '').length > 0,
    baseUrl: baseUrl && baseUrl.trim() !== '' ? baseUrl : API_BASE,
    // 模型固定为契约里的 deepseek-flash，不允许前端改（思考模式下的默认模型）
    model: MODEL_ID,
    theme: theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'dark',
    dailyMinutes: clamp(Math.round(n(readConfigJson('daily_minutes'), 60)), 10, 600),
    remindEnabled: readConfigJson('remind_enabled') === true,
    remindTime: typeof remindTime === 'string' && /^\d{2}:\d{2}$/.test(remindTime) ? remindTime : '20:00',
    reviewEnabled: readConfigJson('review_enabled') !== false,
    reviewEveryDays: clamp(Math.round(n(readConfigJson('review_every_days'), 7)), 1, 90),
    reviewEveryWeekdays: clamp(Math.round(n(readConfigJson('review_every_weekdays'), 2)), 1, 7)
  }
}

export async function getSettings(): Promise<AppSettings> {
  await ensureReady()
  return readSettings()
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  await ensureReady()
  if (!patch || typeof patch !== 'object') throw new AppError('VALIDATION', '设置内容为空')

  if (patch.theme !== undefined) {
    if (patch.theme !== 'dark' && patch.theme !== 'light' && patch.theme !== 'system') {
      throw new AppError('VALIDATION', '主题只能是 dark / light / system')
    }
    writeConfigJson('theme', patch.theme)
  }
  if (patch.dailyMinutes !== undefined) {
    writeConfigJson('daily_minutes', clamp(Math.round(n(patch.dailyMinutes, 60)), 10, 600))
  }
  if (patch.remindEnabled !== undefined) writeConfigJson('remind_enabled', patch.remindEnabled === true)
  if (patch.remindTime !== undefined) {
    const time = String(patch.remindTime)
    if (!/^\d{2}:\d{2}$/.test(time)) throw new AppError('VALIDATION', '提醒时间格式应为 HH:mm')
    writeConfig('remind_time', time)
  }
  if (patch.reviewEnabled !== undefined) writeConfigJson('review_enabled', patch.reviewEnabled === true)
  if (patch.reviewEveryDays !== undefined) {
    writeConfigJson('review_every_days', clamp(Math.round(n(patch.reviewEveryDays, 7)), 1, 90))
  }
  if (patch.reviewEveryWeekdays !== undefined) {
    writeConfigJson('review_every_weekdays', clamp(Math.round(n(patch.reviewEveryWeekdays, 2)), 1, 7))
  }
  if (patch.baseUrl !== undefined) {
    const url = String(patch.baseUrl).trim()
    if (url === '') deleteConfig('base_url')
    else if (!/^https?:\/\//i.test(url)) throw new AppError('VALIDATION', '接口地址必须以 http(s):// 开头')
    else writeConfig('base_url', url.replace(/\/+$/, ''))
  }
  // model 固定，忽略外部传入
  persist()
  const settings = readSettings()
  broadcast(PUSH.SETTINGS_CHANGED, settings)
  return settings
}

/** safeStorage 可用时用系统加密，不可用（极少数 Linux / 未就绪）时退化为 base64 并记日志 */
export async function getApiKey(): Promise<string | null> {
  await ensureReady()
  const raw = readConfig('api_key')
  if (!raw) return null
  try {
    if (raw.startsWith('enc:')) {
      if (!safeStorage.isEncryptionAvailable()) {
        logger.warn('repo', 'safeStorage 不可用，已保存的 Key 无法解密')
        return null
      }
      return safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64'))
    }
    if (raw.startsWith('b64:')) return Buffer.from(raw.slice(4), 'base64').toString('utf8')
    return raw
  } catch (err) {
    logger.error('repo', '读取 API Key 失败', err)
    return null
  }
}

export async function setApiKey(key: string): Promise<void> {
  await ensureReady()
  const trimmed = String(key ?? '').trim()
  if (trimmed === '') {
    deleteConfig('api_key')
    persist()
    broadcast(PUSH.SETTINGS_CHANGED, readSettings())
    return
  }
  let stored: string
  if (safeStorage.isEncryptionAvailable()) {
    stored = `enc:${safeStorage.encryptString(trimmed).toString('base64')}`
  } else {
    logger.warn('repo', 'safeStorage 不可用，API Key 以 base64 明文保存')
    stored = `b64:${Buffer.from(trimmed, 'utf8').toString('base64')}`
  }
  writeConfig('api_key', stored)
  persist()
  broadcast(PUSH.SETTINGS_CHANGED, readSettings())
}

// ───────────────────────────── 映射 ─────────────────────────────

const GOAL_KINDS: readonly GoalKind[] = ['exam', 'skill', 'course', 'project']
const GOAL_LEVELS: readonly GoalLevel[] = ['zero', 'basic', 'some', 'good']
const TASK_KINDS: readonly TaskKind[] = ['read', 'watch', 'practice', 'write', 'review', 'other']
const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'done', 'skipped']
const MATERIAL_KINDS: readonly MaterialKind[] = ['text', 'chapter', 'link', 'note']

function toGoalKind(value: unknown): GoalKind {
  const text = s(value, 'exam')
  return (GOAL_KINDS as readonly string[]).includes(text) ? (text as GoalKind) : 'exam'
}

function toGoalLevel(value: unknown): GoalLevel {
  const text = s(value, 'zero')
  return (GOAL_LEVELS as readonly string[]).includes(text) ? (text as GoalLevel) : 'zero'
}

function toTaskKind(value: unknown): TaskKind {
  const text = s(value, 'other')
  return (TASK_KINDS as readonly string[]).includes(text) ? (text as TaskKind) : 'other'
}

function toTaskStatus(value: unknown): TaskStatus {
  const text = s(value, 'todo')
  return (TASK_STATUSES as readonly string[]).includes(text) ? (text as TaskStatus) : 'todo'
}

function toMaterialKind(value: unknown): MaterialKind {
  const text = s(value, 'text')
  return (MATERIAL_KINDS as readonly string[]).includes(text) ? (text as MaterialKind) : 'text'
}

function toDayStatus(value: unknown): DayStatus {
  const text = s(value, 'locked')
  const allowed: readonly DayStatus[] = ['locked', 'learning', 'exam_ready', 'passed', 'partial', 'failed']
  return (allowed as readonly string[]).includes(text) ? (text as DayStatus) : 'locked'
}

function toQuestionType(value: unknown): QuestionType {
  return s(value) === 'fill_blank' ? 'fill_blank' : 'single_choice'
}

function toRecitationStatus(value: unknown): RecitationStatus {
  const text = s(value, 'awaiting_explain')
  const allowed: readonly RecitationStatus[] = [
    'awaiting_explain',
    'awaiting_followup_answer',
    'grading',
    'graded'
  ]
  return (allowed as readonly string[]).includes(text) ? (text as RecitationStatus) : 'awaiting_explain'
}

function toGoal(row: Row, percent: number): Goal {
  return {
    id: s(row.id),
    title: s(row.title),
    description: s(row.description),
    kind: toGoalKind(row.kind),
    level: toGoalLevel(row.level),
    targetDate: sOrNull(row.target_date),
    dailyMinutes: Math.round(n(row.daily_minutes, 60)),
    progress: percent,
    archived: b(row.archived),
    createdAt: s(row.created_at),
    updatedAt: s(row.updated_at)
  }
}

function toTask(row: Row): Task {
  return {
    id: s(row.id),
    dayId: s(row.day_id),
    index: Math.round(n(row.idx)),
    title: s(row.title),
    kind: toTaskKind(row.kind),
    estMinutes: Math.round(n(row.est_minutes)),
    status: toTaskStatus(row.status),
    note: sOrNull(row.note),
    doneAt: sOrNull(row.done_at)
  }
}

function toDay(row: Row, tasks: Task[]): DayWithTasks {
  return {
    id: s(row.id),
    planId: s(row.plan_id),
    index: Math.round(n(row.idx)),
    title: s(row.title),
    goal: s(row.goal),
    estMinutes: Math.round(n(row.est_minutes)),
    checkpoints: stringList(row.checkpoints),
    status: toDayStatus(row.status),
    progress: round1(n(row.progress)),
    score: nOrNull(row.score),
    examId: sOrNull(row.exam_id),
    tasks
  }
}

function toDayDetail(day: DayWithTasks, planTitle: string, goalId: string, goalTitle: string): DayDetail {
  return { ...day, planTitle, goalId, goalTitle }
}

function toPlan(row: Row): Plan {
  return {
    id: s(row.id),
    goalId: s(row.goal_id),
    title: s(row.title),
    summary: s(row.summary),
    totalDays: Math.round(n(row.total_days)),
    totalMinutes: Math.round(n(row.total_minutes)),
    status: s(row.status, 'active') === 'archived' ? 'archived' : s(row.status, 'active') === 'draft' ? 'draft' : 'active',
    version: Math.round(n(row.version, 1)),
    model: s(row.model),
    createdAt: s(row.created_at)
  }
}

function toPlanSummary(row: Row): PlanSummary {
  return {
    ...toPlan(row),
    goalTitle: s(row.goal_title),
    passedDays: Math.round(n(row.passed_days))
  }
}

function toQuestion(row: Row): Question {
  const options = stringList(row.options)
  return {
    id: s(row.id),
    dayId: s(row.day_id),
    examId: s(row.exam_id),
    index: Math.round(n(row.idx)),
    type: toQuestionType(row.type),
    point: n(row.point, SCORING.objectivePerQuestion),
    knowledgePoint: s(row.knowledge_point),
    stem: s(row.stem),
    options: options.length > 0 ? options : null,
    answer: s(row.answer),
    answerAliases: stringList(row.answer_aliases),
    explanation: s(row.explanation),
    userAnswer: row.user_answer === null || row.user_answer === undefined ? null : s(row.user_answer),
    correct: row.correct === null || row.correct === undefined ? null : b(row.correct)
  }
}

function toExam(row: Row): Exam {
  const raw = s(row.status, 'pending')
  const status = raw === 'graded' ? 'graded' : raw === 'objective_done' ? 'objective_done' : 'pending'
  return {
    id: s(row.id),
    dayId: s(row.day_id),
    status,
    objectiveScore: nOrNull(row.objective_score),
    recitationScore: nOrNull(row.recitation_score),
    totalScore: nOrNull(row.total_score),
    passed: row.passed === null || row.passed === undefined ? null : b(row.passed),
    createdAt: s(row.created_at),
    gradedAt: sOrNull(row.graded_at)
  }
}

function toRecitationTask(row: Row): RecitationTask {
  return {
    id: s(row.id),
    examId: s(row.exam_id),
    status: toRecitationStatus(row.status),
    prompt: s(row.prompt)
  }
}

function toRecitationView(row: Row): RecitationView {
  const messages = jsonValue<unknown>(row.messages, [])
  const dimensions = jsonValue<unknown>(row.dimensions, null)
  return {
    id: s(row.id),
    examId: s(row.exam_id),
    status: toRecitationStatus(row.status),
    prompt: s(row.prompt),
    messages: Array.isArray(messages)
      ? messages
          .filter((m): m is RecitationMessage => {
            const rec = m as RecitationMessage | null
            return !!rec && typeof rec.text === 'string' && (rec.role === 'user' || rec.role === 'student')
          })
          .map((m) => ({ role: m.role, text: m.text, at: s(m.at) }))
      : [],
    followUp: sOrNull(row.follow_up),
    score: nOrNull(row.score),
    dimensions:
      dimensions && typeof dimensions === 'object'
        ? {
            accuracy: clamp(n((dimensions as RecitationDimensions).accuracy), 0, 1),
            coverage: clamp(n((dimensions as RecitationDimensions).coverage), 0, 1),
            example: clamp(n((dimensions as RecitationDimensions).example), 0, 1),
            clarity: clamp(n((dimensions as RecitationDimensions).clarity), 0, 1)
          }
        : null,
    feedback: sOrNull(row.feedback),
    criticalGap: sOrNull(row.critical_gap)
  }
}

function toProgressEvent(row: Row): ProgressEvent {
  const reason = s(row.reason, 'manual')
  const allowed: readonly ProgressEvent['reason'][] = [
    'day_passed',
    'day_partial',
    'review_failed',
    'review_passed',
    'manual'
  ]
  return {
    id: s(row.id),
    goalId: s(row.goal_id),
    dayId: sOrNull(row.day_id),
    delta: round1(n(row.delta)),
    reason: (allowed as readonly string[]).includes(reason)
      ? (reason as ProgressEvent['reason'])
      : 'manual',
    detail: s(row.detail),
    createdAt: s(row.created_at)
  }
}

function toMaterial(row: Row): Material {
  return {
    id: s(row.id),
    goalId: s(row.goal_id),
    title: s(row.title),
    kind: toMaterialKind(row.kind),
    content: s(row.content),
    createdAt: s(row.created_at)
  }
}

// ───────────────────────────── 进度算法 ─────────────────────────────

/** 当前该目标的「有效计划」：优先 active，其次最新 */
function currentPlanRow(goalId: string): Row | null {
  return get<Row>(
    `SELECT * FROM plan WHERE goal_id = ?
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 1`,
    [goalId]
  )
}

/** 用户当前选中的计划：配置里那份只要还属于该目标就用它，否则回退到有效计划 */
function selectedPlanRow(goalId: string): Row | null {
  const savedId = readActivePlanId()
  if (savedId !== null) {
    const row = get<Row>('SELECT * FROM plan WHERE id = ? AND goal_id = ?', [savedId, goalId])
    if (row) return row
  }
  return currentPlanRow(goalId)
}

function planDayRows(planId: string): Row[] {
  return all<Row>('SELECT * FROM day WHERE plan_id = ? ORDER BY idx ASC', [planId])
}

/** 该目标当前选中计划下的全部 day 行（按 idx 升序） */
function goalDayRows(goalId: string): Row[] {
  const plan = selectedPlanRow(goalId)
  if (!plan) return []
  return planDayRows(s(plan.id))
}

/**
 * 进度百分比：Σ(day.progress × day.estMinutes) / Σ(全部 day.estMinutes) × 100，保留 1 位小数。
 * 分母恒为「全部 day」，所以今天学再久也不会超过 100%。
 */
function percentFromRows(rows: readonly Row[]): number {
  let num = 0
  let den = 0
  for (const row of rows) {
    const minutes = n(row.est_minutes)
    num += n(row.progress) * minutes
    den += minutes
  }
  if (den <= 0) return 0
  return round1((num / den) * 100)
}

export function percentOfDays(days: readonly { progress: number; estMinutes: number }[]): number {
  let num = 0
  let den = 0
  for (const day of days) {
    num += day.progress * day.estMinutes
    den += day.estMinutes
  }
  if (den <= 0) return 0
  return round1((num / den) * 100)
}

function percentOfGoal(goalId: string): number {
  return percentFromRows(goalDayRows(goalId))
}

function pushProgress(goalId: string): void {
  try {
    broadcast(PUSH.PROGRESS_CHANGED, { goalId, percent: percentOfGoal(goalId) })
  } catch {
    /* 推送失败不影响主流程 */
  }
}

function insertProgressEventRow(
  goalId: string,
  dayId: string | null,
  delta: number,
  reason: ProgressEvent['reason'],
  detail: string
): ProgressEvent {
  const row: ProgressEvent = {
    id: nowId(),
    goalId,
    dayId,
    delta: round1(delta),
    reason,
    detail,
    createdAt: iso()
  }
  run(
    `INSERT INTO progress_event (id, goal_id, day_id, delta, reason, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.goalId, row.dayId, row.delta, row.reason, row.detail, row.createdAt]
  )
  return row
}

/** 供 finishExam 等内部逻辑使用：写事件 + 推送给前端 */
function appendEvent(
  goalId: string,
  dayId: string | null,
  delta: number,
  reason: ProgressEvent['reason'],
  detail: string
): ProgressEvent {
  const event = insertProgressEventRow(goalId, dayId, delta, reason, detail)
  pushProgress(goalId)
  return event
}

export async function appendProgressEvent(
  goalId: string,
  dayId: string | null,
  delta: number,
  reason: ProgressEvent['reason'],
  detail: string
): Promise<ProgressEvent> {
  await ensureReady()
  const goal = get<Row>('SELECT id FROM goal WHERE id = ?', [goalId])
  if (!goal) throw new AppError('NOT_FOUND', '学习目标不存在')
  const event = appendEvent(goalId, dayId, delta, reason, detail)
  persist()
  return event
}

// ───────────────────────────── Goal ─────────────────────────────

function readGoalPercent(goalId: string): number {
  return percentOfGoal(goalId)
}

export async function listGoals(includeArchived = false): Promise<Goal[]> {
  await ensureReady()
  const rows = all<Row>(
    `SELECT * FROM goal ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY created_at DESC`
  )
  return rows.map((row) => toGoal(row, readGoalPercent(s(row.id))))
}

export async function getGoal(id: string): Promise<Goal | null> {
  await ensureReady()
  const row = get<Row>('SELECT * FROM goal WHERE id = ?', [id])
  return row ? toGoal(row, readGoalPercent(id)) : null
}

function requireGoalRow(id: string): Row {
  const row = get<Row>('SELECT * FROM goal WHERE id = ?', [id])
  if (!row) throw new AppError('NOT_FOUND', '学习目标不存在')
  return row
}

function normalizeTargetDate(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (text === '') return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new AppError('VALIDATION', '目标日期格式应为 YYYY-MM-DD')
  }
  return text
}

export async function createGoal(input: GoalInput): Promise<Goal> {
  await ensureReady()
  const title = String(input?.title ?? '').trim()
  if (title === '') throw new AppError('VALIDATION', '请填写学习目标名称')
  if (title.length > 120) throw new AppError('VALIDATION', '目标名称不能超过 120 字')

  const id = nowId()
  const at = iso()
  const dailyMinutes = clamp(Math.round(n(input?.dailyMinutes, 60)), 10, 600)
  run(
    `INSERT INTO goal (id, title, description, kind, level, target_date, daily_minutes, archived, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      id,
      title,
      String(input?.description ?? ''),
      toGoalKind(input?.kind),
      toGoalLevel(input?.level),
      normalizeTargetDate(input?.targetDate),
      dailyMinutes,
      at,
      at
    ]
  )
  persist()
  // 新建目标后直接切过去，用户下一步就是给它生成计划
  writeActiveContext(id, null)
  persist()
  broadcast(PUSH.PROGRESS_CHANGED, { goalId: id, percent: 0 })
  const created = await getGoal(id)
  if (!created) throw new AppError('DB', '创建学习目标失败')
  return created
}

export interface GoalPatch extends Partial<Omit<GoalInput, 'targetDate'>> {
  targetDate?: string | null
  archived?: boolean
}

export async function updateGoal(id: string, patch: GoalPatch): Promise<Goal> {
  await ensureReady()
  requireGoalRow(id)
  if (!patch || typeof patch !== 'object') throw new AppError('VALIDATION', '没有需要修改的内容')

  const sets: string[] = []
  const params: (string | number | null)[] = []

  if (patch.title !== undefined) {
    const title = String(patch.title).trim()
    if (title === '') throw new AppError('VALIDATION', '目标名称不能为空')
    sets.push('title = ?')
    params.push(title)
  }
  if (patch.description !== undefined) {
    sets.push('description = ?')
    params.push(String(patch.description ?? ''))
  }
  if (patch.kind !== undefined) {
    sets.push('kind = ?')
    params.push(toGoalKind(patch.kind))
  }
  if (patch.level !== undefined) {
    sets.push('level = ?')
    params.push(toGoalLevel(patch.level))
  }
  if (patch.targetDate !== undefined) {
    sets.push('target_date = ?')
    params.push(normalizeTargetDate(patch.targetDate))
  }
  if (patch.dailyMinutes !== undefined) {
    sets.push('daily_minutes = ?')
    params.push(clamp(Math.round(n(patch.dailyMinutes, 60)), 10, 600))
  }
  if (patch.archived !== undefined) {
    sets.push('archived = ?')
    params.push(boolParam(patch.archived === true))
  }

  if (sets.length === 0) {
    const current = await getGoal(id)
    if (!current) throw new AppError('NOT_FOUND', '学习目标不存在')
    return current
  }

  sets.push('updated_at = ?')
  params.push(iso())
  params.push(id)
  run(`UPDATE goal SET ${sets.join(', ')} WHERE id = ?`, params)
  persist()
  broadcast(PUSH.PROGRESS_CHANGED, { goalId: id, percent: percentOfGoal(id) })
  const updated = await getGoal(id)
  if (!updated) throw new AppError('NOT_FOUND', '学习目标不存在')
  return updated
}

export async function deleteGoal(id: string): Promise<void> {
  await ensureReady()
  requireGoalRow(id)
  // 显式级联：sql.js 的外键级联偶发不生效，这里逐个表删干净，避免留下孤儿数据污染统计
  transaction(() => {
    run('DELETE FROM goal WHERE id = ?', [id])
    run('DELETE FROM plan WHERE goal_id = ?', [id])
    run('DELETE FROM day WHERE goal_id = ?', [id])
    run('DELETE FROM exam WHERE goal_id = ?', [id])
    run('DELETE FROM progress_event WHERE goal_id = ?', [id])
    run('DELETE FROM material WHERE goal_id = ?', [id])
    run('DELETE FROM task WHERE day_id NOT IN (SELECT id FROM day)')
    run('DELETE FROM lesson WHERE day_id NOT IN (SELECT id FROM day)')
    run('DELETE FROM question WHERE exam_id NOT IN (SELECT id FROM exam)')
    run('DELETE FROM recitation WHERE exam_id NOT IN (SELECT id FROM exam)')
    // 删掉的若是当前目标，把选择清掉，下次自动挑一个存在的
    if (readActiveGoalId() === id) writeActiveContext(null, null)
  })
  persist()
  broadcast(PUSH.PROGRESS_CHANGED, { goalId: id, percent: 0 })
}

// ───────────────────────────── Plan ─────────────────────────────

function sanitizeGeneratedPlan(generated: GeneratedPlan): GeneratedPlan {
  if (!generated || !Array.isArray(generated.days) || generated.days.length === 0) {
    throw new AppError('VALIDATION', '计划内容为空，无法保存')
  }
  const days = generated.days.map((day, index) => ({
    index: index + 1,
    title: String(day?.title ?? '').trim() || `第 ${index + 1} 天`,
    goal: String(day?.goal ?? '').trim(),
    estMinutes: clamp(Math.round(n(day?.estMinutes, 60)), 5, 600),
    checkpoints: Array.isArray(day?.checkpoints)
      ? day.checkpoints.filter((c) => typeof c === 'string' && c.trim() !== '').map((c) => c.trim())
      : [],
    tasks: Array.isArray(day?.tasks)
      ? day.tasks.map((task) => ({
          title: String(task?.title ?? '').trim() || '学习任务',
          kind: toTaskKind(task?.kind),
          estMinutes: clamp(Math.round(n(task?.estMinutes, 15)), 5, 600)
        }))
      : []
  }))
  return {
    title: String(generated.title ?? '').trim() || '学习计划',
    summary: String(generated.summary ?? '').trim(),
    totalDays: days.length,
    days
  }
}

export async function savePlan(goalId: string, generated: GeneratedPlan): Promise<Plan> {
  await ensureReady()
  requireGoalRow(goalId)
  const plan = sanitizeGeneratedPlan(generated)
  const at = iso()

  const planId = transaction(() => {
    const previousVersion =
      n(get<Row>('SELECT MAX(version) AS v FROM plan WHERE goal_id = ?', [goalId])?.v, 0) + 1
    // 旧计划归档，但 day/task 数据保留（历史进度事件仍可追溯）
    run(`UPDATE plan SET status = 'archived' WHERE goal_id = ? AND status = 'active'`, [goalId])

    const id = nowId()
    const totalMinutes = plan.days.reduce(
      (sum, day) => sum + day.tasks.reduce((s2, task) => s2 + task.estMinutes, 0),
      0
    )
    run(
      `INSERT INTO plan (id, goal_id, title, summary, total_days, total_minutes, status, version, model, raw_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      [
        id,
        goalId,
        plan.title,
        plan.summary,
        plan.days.length,
        totalMinutes,
        previousVersion,
        MODEL_ID,
        JSON.stringify(plan),
        at
      ]
    )

    plan.days.forEach((day, index) => {
      const dayId = nowId()
      run(
        `INSERT INTO day (id, plan_id, goal_id, idx, title, goal, est_minutes, status, progress, score, exam_id, checkpoints, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)`,
        [
          dayId,
          id,
          goalId,
          index + 1,
          day.title,
          day.goal,
          day.estMinutes,
          index === 0 ? 'learning' : 'locked',
          JSON.stringify(day.checkpoints),
          at
        ]
      )
      day.tasks.forEach((task, taskIndex) => {
        run(
          `INSERT INTO task (id, day_id, idx, title, kind, est_minutes, status, note, done_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'todo', NULL, NULL, ?)`,
          [nowId(), dayId, taskIndex + 1, task.title, task.kind, task.estMinutes, at]
        )
      })
    })
    return id
  })

  // 新计划保存后自动切到它（多计划场景下用户期望「刚建的就是当前的」）
  writeActiveContext(goalId, planId)
  persist()
  pushProgress(goalId)
  const row = get<Row>('SELECT * FROM plan WHERE id = ?', [planId])
  if (!row) throw new AppError('DB', '保存计划失败')
  return toPlan(row)
}

export async function listPlans(goalId?: string): Promise<PlanSummary[]> {
  await ensureReady()
  const rows = all<Row>(
    `SELECT p.*, g.title AS goal_title,
            (SELECT COUNT(*) FROM day d WHERE d.plan_id = p.id AND d.status = 'passed') AS passed_days
       FROM plan p
       JOIN goal g ON g.id = p.goal_id
      WHERE (? IS NULL OR p.goal_id = ?)
      ORDER BY p.created_at DESC`,
    [goalId ?? null, goalId ?? null]
  )
  return rows.map(toPlanSummary)
}

export async function deletePlan(id: string): Promise<void> {
  await ensureReady()
  const row = get<Row>('SELECT goal_id FROM plan WHERE id = ?', [id])
  if (!row) throw new AppError('NOT_FOUND', '计划不存在')
  const goalId = s(row.goal_id)
  transaction(() => {
    run('DELETE FROM plan WHERE id = ?', [id])
    run('DELETE FROM day WHERE plan_id = ?', [id])
    run('DELETE FROM task WHERE day_id NOT IN (SELECT id FROM day)')
    run('DELETE FROM lesson WHERE day_id NOT IN (SELECT id FROM day)')
    run('DELETE FROM exam WHERE day_id NOT IN (SELECT id FROM day)')
    run('DELETE FROM question WHERE exam_id NOT IN (SELECT id FROM exam)')
    run('DELETE FROM recitation WHERE exam_id NOT IN (SELECT id FROM exam)')
    // 删掉的若是当前计划，清掉选择，回退到该目标剩下的有效计划
    if (readActivePlanId() === id) deleteConfig(ACTIVE_PLAN_KEY)
  })
  persist()
  pushProgress(goalId)
}

// ───────────────────────────── Day / Task ─────────────────────────────

function tasksOfDay(dayId: string): Task[] {
  return all<Row>('SELECT * FROM task WHERE day_id = ? ORDER BY idx ASC', [dayId]).map(toTask)
}

function tasksByPlan(planId: string): Map<string, Task[]> {
  const rows = all<Row>(
    `SELECT t.* FROM task t JOIN day d ON d.id = t.day_id WHERE d.plan_id = ? ORDER BY t.idx ASC`,
    [planId]
  )
  const grouped = new Map<string, Task[]>()
  for (const row of rows) {
    const dayId = s(row.day_id)
    const list = grouped.get(dayId) ?? []
    list.push(toTask(row))
    grouped.set(dayId, list)
  }
  return grouped
}

export async function listDays(planId: string): Promise<DayWithTasks[]> {
  await ensureReady()
  const rows = all<Row>('SELECT * FROM day WHERE plan_id = ? ORDER BY idx ASC', [planId])
  const grouped = tasksByPlan(planId)
  return rows.map((row) => toDay(row, grouped.get(s(row.id)) ?? []))
}

export async function getDayWithTasks(dayId: string): Promise<DayWithTasks | null> {
  await ensureReady()
  const row = get<Row>('SELECT * FROM day WHERE id = ?', [dayId])
  return row ? toDay(row, tasksOfDay(dayId)) : null
}

export async function getDayDetail(dayId: string): Promise<DayDetail | null> {
  await ensureReady()
  const row = get<Row>(
    `SELECT d.*, p.title AS plan_title, p.goal_id AS goal_id, g.title AS goal_title
       FROM day d
       JOIN plan p ON p.id = d.plan_id
       JOIN goal g ON g.id = p.goal_id
      WHERE d.id = ?`,
    [dayId]
  )
  if (!row) return null
  const day = toDay(row, tasksOfDay(dayId))
  return toDayDetail(day, s(row.plan_title), s(row.goal_id), s(row.goal_title))
}

/** 全部任务完成 → exam_ready；有任务被撤销且仍在待检测 → 回到 learning */
function recomputeDayStatus(dayId: string): boolean {
  const day = get<Row>('SELECT status FROM day WHERE id = ?', [dayId])
  if (!day) return false
  const tasks = all<Row>('SELECT status FROM task WHERE day_id = ?', [dayId])
  if (tasks.length === 0) return false
  const allDone = tasks.every((task) => s(task.status) === 'done')
  const current = toDayStatus(day.status)
  let next: DayStatus = current

  if (allDone) {
    if (current === 'learning' || current === 'failed') next = 'exam_ready'
  } else if (current === 'exam_ready') {
    next = 'learning'
  }

  if (next !== current) {
    run('UPDATE day SET status = ? WHERE id = ?', [next, dayId])
    return true
  }
  return false
}

export async function setTaskStatus(taskId: string, status: TaskStatus): Promise<DayDetail> {
  await ensureReady()
  if (!(TASK_STATUSES as readonly string[]).includes(String(status))) {
    throw new AppError('VALIDATION', `未知的任务状态：${String(status)}`)
  }
  const next = status as TaskStatus
  const row = get<Row>('SELECT * FROM task WHERE id = ?', [taskId])
  if (!row) throw new AppError('NOT_FOUND', '任务不存在')
  const dayId = s(row.day_id)
  const previousDoneAt = sOrNull(row.done_at)

  transaction(() => {
    const doneAt = next === 'done' ? previousDoneAt ?? iso() : null
    run('UPDATE task SET status = ?, done_at = ? WHERE id = ?', [next, doneAt, taskId])
    recomputeDayStatus(dayId)
  })

  persist()
  broadcast(PUSH.TASK_CHANGED, { taskId, dayId, status: next })
  const day = get<Row>('SELECT goal_id FROM day WHERE id = ?', [dayId])
  if (day) pushProgress(s(day.goal_id))

  const detail = await getDayDetail(dayId)
  if (!detail) throw new AppError('NOT_FOUND', '任务所属的 Day 不存在')
  return detail
}

export async function setTaskNote(taskId: string, note: string | null): Promise<void> {
  await ensureReady()
  run('UPDATE task SET note = ? WHERE id = ?', [note === null ? null : String(note), taskId])
  persist()
}

// ───────────────────────────── 进度视图 ─────────────────────────────

export async function getProgressSummary(
  goalId: string,
  planId?: string | null
): Promise<ProgressSummary> {
  await ensureReady()
  const goalRow = get<Row>('SELECT id, daily_minutes FROM goal WHERE id = ?', [goalId])
  if (!goalRow) throw new AppError('NOT_FOUND', '学习目标不存在')

  const days = planId != null && planId !== '' ? planDayRows(planId) : goalDayRows(goalId)
  const percent = percentFromRows(days)
  const since = iso(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
  const weekMinutes = n(
    get<Row>(
      `SELECT COALESCE(SUM(est_minutes), 0) AS m FROM task
        WHERE done_at IS NOT NULL AND done_at >= ?
          AND day_id IN (SELECT id FROM day WHERE goal_id = ?)`,
      [since, goalId]
    )?.m,
    0
  )

  let passedDays = 0
  let partialDays = 0
  for (const day of days) {
    const status = toDayStatus(day.status)
    if (status === 'passed') passedDays += 1
    else if (status === 'partial') partialDays += 1
  }

  return {
    goalId,
    percent,
    totalDays: days.length,
    passedDays,
    partialDays,
    segments: days.map((day) => ({
      dayId: s(day.id),
      index: Math.round(n(day.idx)),
      title: s(day.title),
      progress: round1(n(day.progress)),
      status: toDayStatus(day.status)
    })),
    weekMinutes: Math.round(weekMinutes)
  }
}

export async function listProgressEvents(goalId: string, limit = 50): Promise<ProgressEvent[]> {
  await ensureReady()
  const size = clamp(Math.round(n(limit, 50)), 1, 500)
  const rows = all<Row>(
    'SELECT * FROM progress_event WHERE goal_id = ? ORDER BY created_at DESC LIMIT ?',
    [goalId, size]
  )
  return rows.map(toProgressEvent)
}

/** 复检扣分：只动 day.progress，再按整目标百分比记一条负增量事件 */
export async function applyDayProgressDelta(
  dayId: string,
  deltaProgress: number,
  reason: ProgressEvent['reason'],
  detail: string
): Promise<{ percent: number; delta: number }> {
  await ensureReady()
  const day = get<Row>('SELECT * FROM day WHERE id = ?', [dayId])
  if (!day) throw new AppError('NOT_FOUND', 'Day 不存在')
  const goalId = s(day.goal_id)
  const before = percentOfGoal(goalId)
  const nextProgress = clamp(n(day.progress) + deltaProgress, 0, 1)
  const currentStatus = toDayStatus(day.status)
  let nextStatus: DayStatus = currentStatus
  if (currentStatus === 'passed' && nextProgress < 1) {
    nextStatus = nextProgress > 0 ? 'partial' : 'failed'
  }

  transaction(() => {
    run('UPDATE day SET progress = ?, status = ? WHERE id = ?', [
      round1(nextProgress),
      nextStatus,
      dayId
    ])
    const after = percentOfGoal(goalId)
    insertProgressEventRow(goalId, dayId, round1(after - before), reason, detail)
  })

  persist()
  const percent = percentOfGoal(goalId)
  pushProgress(goalId)
  return { percent, delta: round1(percent - before) }
}

// ───────────────────────────── 统计 / Bootstrap ─────────────────────────────

function localDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export async function getStatsOverview(): Promise<StatsOverview> {
  await ensureReady()

  const totalGoals = n(get<Row>('SELECT COUNT(*) AS c FROM goal')?.c, 0)
  const activeGoals = n(get<Row>('SELECT COUNT(*) AS c FROM goal WHERE archived = 0')?.c, 0)
  const totalDaysPassed = n(get<Row>(`SELECT COUNT(*) AS c FROM day WHERE status = 'passed'`)?.c, 0)

  const doneTasks = all<Row>(
    'SELECT est_minutes, done_at FROM task WHERE done_at IS NOT NULL ORDER BY done_at ASC'
  )
  const minutesByDay = new Map<string, number>()
  let totalMinutes = 0
  for (const task of doneTasks) {
    const minutes = Math.round(n(task.est_minutes))
    totalMinutes += minutes
    const at = sOrNull(task.done_at)
    if (!at) continue
    const date = new Date(at)
    if (Number.isNaN(date.getTime())) continue
    const key = localDateKey(date)
    minutesByDay.set(key, (minutesByDay.get(key) ?? 0) + minutes)
  }

  const dailyMinutes: StatsOverview['dailyMinutes'] = []
  const today = new Date()
  for (let i = 13; i >= 0; i -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    const key = localDateKey(date)
    dailyMinutes.push({ date: key, minutes: minutesByDay.get(key) ?? 0 })
  }

  // 连续学习天数：从今天（或昨天，今天还没学也算连着）往前数
  let streakDays = 0
  const cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  if ((minutesByDay.get(localDateKey(cursor)) ?? 0) === 0) {
    cursor.setDate(cursor.getDate() - 1)
  }
  while ((minutesByDay.get(localDateKey(cursor)) ?? 0) > 0) {
    streakDays += 1
    cursor.setDate(cursor.getDate() - 1)
  }

  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString()
  const monthCost = n(
    get<Row>('SELECT COALESCE(SUM(cost), 0) AS c FROM ai_usage WHERE created_at >= ?', [monthStart])?.c,
    0
  )

  return {
    totalGoals,
    activeGoals,
    totalDaysPassed,
    totalMinutes: Math.round(totalMinutes),
    dailyMinutes,
    monthCost: Math.round(monthCost * 10000) / 10000,
    streakDays
  }
}

/** 当前应该打开的目标：配置里选过的优先，否则取第一个有 active 计划的目标 */
function resolveActiveGoalRow(goalRows: readonly Row[]): Row | null {
  const savedId = readActiveGoalId()
  if (savedId !== null) {
    const hit = goalRows.find((row) => s(row.id) === savedId)
    if (hit) return hit
  }
  return pickActiveGoalRow(goalRows)
}

/** 当前应该打开的 plan：优先有 active 计划的最近目标 */
function pickActiveGoalRow(goalRows: readonly Row[]): Row | null {
  for (const row of goalRows) {
    if (get<Row>(`SELECT id FROM plan WHERE goal_id = ? AND status = 'active' LIMIT 1`, [s(row.id)])) {
      return row
    }
  }
  return goalRows.length > 0 ? goalRows[0] : null
}

function pickTodayDayOfPlan(planId: string): DayWithTasks | null {
  const candidates = all<Row>(
    `SELECT * FROM day
      WHERE plan_id = ? AND status IN ('exam_ready', 'learning')
      ORDER BY CASE status WHEN 'exam_ready' THEN 0 ELSE 1 END, idx ASC
      LIMIT 1`,
    [planId]
  )
  const row = candidates[0]
  if (!row) return null
  return toDay(row, tasksOfDay(s(row.id)))
}

function pickTodayDay(goalId: string): DayWithTasks | null {
  const plan = selectedPlanRow(goalId)
  if (!plan) return null
  return pickTodayDayOfPlan(s(plan.id))
}

function planSummaryOf(planId: string): PlanSummary | null {
  const row = get<Row>(
    `SELECT p.*, g.title AS goal_title,
            (SELECT COUNT(*) FROM day d WHERE d.plan_id = p.id AND d.status = 'passed') AS passed_days
       FROM plan p JOIN goal g ON g.id = p.goal_id
      WHERE p.id = ?`,
    [planId]
  )
  return row ? toPlanSummary(row) : null
}

export async function getBootstrap(): Promise<BootstrapData> {
  await ensureReady()
  const settings = readSettings()
  const goalRows = all<Row>('SELECT * FROM goal WHERE archived = 0 ORDER BY created_at DESC')
  const goals = goalRows.map((row) => toGoal(row, percentOfGoal(s(row.id))))

  const activeGoal = resolveActiveGoalRow(goalRows)
  const activeGoalId = activeGoal ? s(activeGoal.id) : null

  let plans: PlanSummary[] = []
  let activePlan: PlanSummary | null = null
  let progress: ProgressSummary | null = null
  let todayDay: DayWithTasks | null = null

  if (activeGoalId !== null) {
    plans = await listPlans(activeGoalId)
    const plan = selectedPlanRow(activeGoalId)
    if (plan) {
      const planId = s(plan.id)
      activePlan = planSummaryOf(planId)
      progress = await getProgressSummary(activeGoalId, planId)
      todayDay = pickTodayDayOfPlan(planId)
    }
  }

  return {
    settings,
    goals,
    activeGoalId,
    plans,
    activePlan,
    progress,
    todayDay,
    stats: await getStatsOverview()
  }
}

/**
 * 切换「当前目标 / 当前计划」，返回切换后的 bootstrap。
 * · 只给 goalId：切目标，计划自动落到该目标的有效计划
 * · 只给 planId：切计划，目标跟着计划走
 * · goalId: null：清空选择（回到自动挑选）
 */
export async function setActiveContext(input: ContextInput): Promise<BootstrapData> {
  await ensureReady()
  const patch = input ?? {}
  let goalId: string | null | undefined =
    patch.goalId === undefined ? undefined : patch.goalId === null ? null : String(patch.goalId).trim()
  let planId: string | null | undefined =
    patch.planId === undefined ? undefined : patch.planId === null ? null : String(patch.planId).trim()

  if (goalId === '') goalId = null
  if (planId === '') planId = null

  // 给了 planId：先按计划反查目标，顺带校验归属
  if (planId !== undefined && planId !== null) {
    const planRow = get<Row>('SELECT goal_id FROM plan WHERE id = ?', [planId])
    if (!planRow) throw new AppError('NOT_FOUND', '计划不存在')
    const planGoalId = s(planRow.goal_id)
    if (goalId !== undefined && goalId !== null && goalId !== planGoalId) {
      throw new AppError('VALIDATION', '这份计划不属于该目标')
    }
    goalId = planGoalId
  }

  if (goalId !== undefined && goalId !== null) {
    const goalRow = get<Row>('SELECT id FROM goal WHERE id = ? AND archived = 0', [goalId])
    if (!goalRow) throw new AppError('NOT_FOUND', '学习目标不存在')
  }

  transaction(() => {
    if (goalId === null) {
      writeActiveContext(null, null)
      return
    }
    if (goalId !== undefined) {
      // 换目标时把计划选择清掉，交给 selectedPlanRow 落到有效计划
      writeActiveContext(goalId, planId ?? null)
      return
    }
    if (planId !== undefined && planId !== null) writeConfig(ACTIVE_PLAN_KEY, planId)
  })

  persist()
  return getBootstrap()
}

// ───────────────────────────── 资料 ─────────────────────────────

export interface MaterialInput {
  goalId: string
  title: string
  kind?: MaterialKind
  content: string
}

export async function addMaterial(input: MaterialInput): Promise<Material> {
  await ensureReady()
  const goalId = String(input?.goalId ?? '').trim()
  if (!goalId) throw new AppError('VALIDATION', '缺少 goalId')
  requireGoalRow(goalId)
  const content = String(input?.content ?? '')
  const title = String(input?.title ?? '').trim() || '未命名资料'
  const id = nowId()
  const at = iso()
  run(
    `INSERT INTO material (id, goal_id, title, kind, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, goalId, title, toMaterialKind(input?.kind), content, at]
  )
  persist()
  const row = get<Row>('SELECT * FROM material WHERE id = ?', [id])
  if (!row) throw new AppError('DB', '保存资料失败')
  return toMaterial(row)
}

export async function listMaterials(goalId: string): Promise<Material[]> {
  await ensureReady()
  const rows = all<Row>('SELECT * FROM material WHERE goal_id = ? ORDER BY created_at DESC', [goalId])
  return rows.map(toMaterial)
}

export async function deleteMaterial(id: string): Promise<void> {
  await ensureReady()
  const row = get<Row>('SELECT id FROM material WHERE id = ?', [id])
  if (!row) throw new AppError('NOT_FOUND', '资料不存在')
  run('DELETE FROM material WHERE id = ?', [id])
  persist()
}

// ───────────────────────────── 每日教案 ─────────────────────────────

/** 教案正文（payload 列里的 JSON），与 Lesson 一一对应 */
export interface LessonPayload {
  title: string
  overview: string
  sections: LessonSection[]
  practices: LessonPractice[]
  guides: LessonGuide[]
  misconceptions: string[]
  selfCheck: string[]
}

export const EMPTY_LESSON_PAYLOAD: LessonPayload = {
  title: '',
  overview: '',
  sections: [],
  practices: [],
  guides: [],
  misconceptions: [],
  selfCheck: []
}

function toLessonStatus(value: unknown): Lesson['status'] {
  const text = String(value ?? '').trim()
  if (text === 'generating' || text === 'ready' || text === 'failed' || text === 'empty') return text
  return 'empty'
}

function toLesson(row: Row): Lesson {
  let payload: LessonPayload = { ...EMPTY_LESSON_PAYLOAD }
  const raw = String(row.payload ?? '').trim()
  if (raw !== '') {
    try {
      const parsed = JSON.parse(raw) as Partial<LessonPayload>
      payload = {
        title: String(parsed.title ?? ''),
        overview: String(parsed.overview ?? ''),
        sections: Array.isArray(parsed.sections) ? (parsed.sections as LessonSection[]) : [],
        practices: Array.isArray(parsed.practices) ? (parsed.practices as LessonPractice[]) : [],
        guides: Array.isArray(parsed.guides) ? (parsed.guides as LessonGuide[]) : [],
        misconceptions: Array.isArray(parsed.misconceptions) ? (parsed.misconceptions as string[]) : [],
        selfCheck: Array.isArray(parsed.selfCheck) ? (parsed.selfCheck as string[]) : []
      }
    } catch (error) {
      logger.warn('db', '教案 payload 解析失败，按空教案处理', { dayId: row.day_id, error: String(error) })
    }
  }
  const errorText = String(row.error ?? '').trim()
  return {
    dayId: String(row.day_id),
    status: toLessonStatus(row.status),
    title: payload.title,
    overview: payload.overview,
    sections: payload.sections,
    practices: payload.practices,
    guides: payload.guides,
    misconceptions: payload.misconceptions,
    selfCheck: payload.selfCheck,
    error: errorText === '' ? null : errorText,
    updatedAt: typeof row.updated_at === 'string' && row.updated_at !== '' ? row.updated_at : null
  }
}

/** 读教案；没有记录时返回空教案（status='empty'），前端据此显示「AI 备课」入口 */
export async function getLesson(dayId: string): Promise<Lesson> {
  await ensureReady()
  const row = get<Row>('SELECT * FROM lesson WHERE day_id = ?', [dayId])
  if (!row) {
    return { dayId, status: 'empty', ...EMPTY_LESSON_PAYLOAD, error: null, updatedAt: null }
  }
  return toLesson(row)
}

/** 只改状态（生成中 / 失败），不覆盖已有正文 */
export async function setLessonStatus(
  dayId: string,
  status: Lesson['status'],
  error = ''
): Promise<Lesson> {
  await ensureReady()
  const at = iso()
  const existing = get<Row>('SELECT payload FROM lesson WHERE day_id = ?', [dayId])
  if (!existing) {
    run('INSERT INTO lesson (day_id, status, payload, error, updated_at) VALUES (?, ?, ?, ?, ?)', [
      dayId,
      status,
      '',
      error,
      at
    ])
  } else {
    run('UPDATE lesson SET status = ?, error = ?, updated_at = ? WHERE day_id = ?', [status, error, at, dayId])
  }
  persist()
  return getLesson(dayId)
}

/** 保存教案正文并把状态置为 ready */
export async function saveLesson(dayId: string, payload: LessonPayload): Promise<Lesson> {
  await ensureReady()
  const row = get<Row>('SELECT id FROM day WHERE id = ?', [dayId])
  if (!row) throw new AppError('NOT_FOUND', '学习日不存在')
  const at = iso()
  const text = JSON.stringify(payload)
  const existing = get<Row>('SELECT day_id FROM lesson WHERE day_id = ?', [dayId])
  if (!existing) {
    run('INSERT INTO lesson (day_id, status, payload, error, updated_at) VALUES (?, ?, ?, ?, ?)', [
      dayId,
      'ready',
      text,
      '',
      at
    ])
  } else {
    run('UPDATE lesson SET status = ?, payload = ?, error = ?, updated_at = ? WHERE day_id = ?', [
      'ready',
      text,
      '',
      at,
      dayId
    ])
  }
  persist()
  return getLesson(dayId)
}


// ───────────────────────────── Exam / Question ─────────────────────────────

export interface QuestionInput {
  type: QuestionType
  knowledgePoint: string
  stem: string
  options?: string[] | null
  answer: string
  answerAliases?: string[]
  explanation?: string
  point?: number
}

export async function insertExam(dayId: string, data?: { status?: string }): Promise<Exam> {
  await ensureReady()
  const day = get<Row>('SELECT * FROM day WHERE id = ?', [dayId])
  if (!day) throw new AppError('NOT_FOUND', 'Day 不存在')
  const id = nowId()
  const at = iso()
  const status = data?.status === 'objective_done' ? 'objective_done' : 'pending'
  transaction(() => {
    run(
      `INSERT INTO exam (id, day_id, goal_id, status, objective_score, recitation_score, total_score, passed, created_at, graded_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL)`,
      [id, dayId, s(day.goal_id), status, at]
    )
    // day.exam_id 始终指向「最近一次考试」
    run('UPDATE day SET exam_id = ? WHERE id = ?', [id, dayId])
  })
  persist()
  const row = get<Row>('SELECT * FROM exam WHERE id = ?', [id])
  if (!row) throw new AppError('DB', '创建考试失败')
  return toExam(row)
}

export async function getExam(examId: string): Promise<Exam | null> {
  await ensureReady()
  const row = get<Row>('SELECT * FROM exam WHERE id = ?', [examId])
  return row ? toExam(row) : null
}

export async function requireExam(examId: string): Promise<Exam> {
  const exam = await getExam(examId)
  if (!exam) throw new AppError('NOT_FOUND', '考试不存在')
  return exam
}

export async function insertQuestions(
  dayId: string,
  examId: string,
  questions: readonly QuestionInput[]
): Promise<Question[]> {
  await ensureReady()
  if (questions.length === 0) throw new AppError('VALIDATION', '题目为空')
  const ids: string[] = []
  transaction(() => {
    questions.forEach((question, index) => {
      const id = nowId()
      ids.push(id)
      run(
        `INSERT INTO question (id, day_id, exam_id, idx, type, knowledge_point, stem, options, answer, answer_aliases, explanation, point, user_answer, correct)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        [
          id,
          dayId,
          examId,
          index + 1,
          toQuestionType(question.type),
          String(question.knowledgePoint ?? ''),
          String(question.stem ?? ''),
          JSON.stringify(Array.isArray(question.options) ? question.options : []),
          String(question.answer ?? ''),
          JSON.stringify(Array.isArray(question.answerAliases) ? question.answerAliases : []),
          String(question.explanation ?? ''),
          n(question.point, SCORING.objectivePerQuestion)
        ]
      )
    })
  })
  persist()
  const rows = all<Row>('SELECT * FROM question WHERE exam_id = ? ORDER BY idx ASC', [examId])
  return rows.map(toQuestion)
}

export async function listQuestions(examId: string): Promise<Question[]> {
  await ensureReady()
  const rows = all<Row>('SELECT * FROM question WHERE exam_id = ? ORDER BY idx ASC', [examId])
  return rows.map(toQuestion)
}

export async function getQuestionsByIds(ids: readonly string[]): Promise<Question[]> {
  await ensureReady()
  const clean = ids.filter((id) => typeof id === 'string' && id.trim() !== '')
  if (clean.length === 0) return []
  const placeholders = clean.map(() => '?').join(', ')
  const rows = all<Row>(`SELECT * FROM question WHERE id IN (${placeholders}) ORDER BY idx ASC`, clean)
  return rows.map(toQuestion)
}

/** 复检抽题：只从「已经考过」的 Day 里随机抽 */
export async function pickReviewQuestions(goalId: string, count = 2): Promise<Question[]> {
  await ensureReady()
  const size = clamp(Math.round(n(count, 2)), 1, 10)
  const rows = all<Row>(
    `SELECT q.* FROM question q
       JOIN day d ON d.id = q.day_id
      WHERE d.goal_id = ? AND d.status IN ('passed', 'partial')
      ORDER BY RANDOM()
      LIMIT ?`,
    [goalId, size]
  )
  return rows.map(toQuestion)
}

/** 本地判客观题：单选比下标，填空 normalize 后比 answer/aliases */
export async function submitObjective(
  examId: string,
  answers: unknown
): Promise<ExamObjectiveResult> {
  await ensureReady()
  const exam = await requireExam(examId)
  if (exam.status === 'graded') throw new AppError('VALIDATION', '这次考试已经结算，不能重复提交')

  const questions = await listQuestions(examId)
  if (questions.length === 0) throw new AppError('NOT_FOUND', '这次考试没有题目')

  const answerMap = extractAnswerMap(answers, questions)
  if (answerMap.size === 0) throw new AppError('VALIDATION', '缺少答题内容')
  const perQuestion: ExamObjectiveResult['perQuestion'] = []
  let objectiveScore = 0

  transaction(() => {
    for (const question of questions) {
      const raw = answerMap.get(question.id) ?? ''
      const { correct, userAnswer } = judgeQuestion(question, raw)
      if (correct) objectiveScore += question.point
      run('UPDATE question SET user_answer = ?, correct = ? WHERE id = ?', [
        userAnswer,
        boolParam(correct),
        question.id
      ])
      perQuestion.push({
        questionId: question.id,
        correct,
        userAnswer,
        answer: question.answer,
        explanation: question.explanation
      })
    }
    run(`UPDATE exam SET objective_score = ?, status = 'objective_done' WHERE id = ?`, [
      objectiveScore,
      examId
    ])
  })

  persist()
  const updated = await requireExam(examId)
  return { exam: updated, perQuestion, objectiveScore }
}

/** 客观题明细（供复述结算时回传前端） */
export async function getObjectiveDetail(examId: string): Promise<ExamObjectiveResult['perQuestion']> {
  await ensureReady()
  const rows = all<Row>('SELECT * FROM question WHERE exam_id = ? ORDER BY idx ASC', [examId])
  return rows
    .filter((row) => row.user_answer !== null && row.user_answer !== undefined)
    .map((row) => ({
      questionId: s(row.id),
      correct: b(row.correct),
      userAnswer: s(row.user_answer),
      answer: s(row.answer),
      explanation: s(row.explanation)
    }))
}

export async function finishExam(
  examId: string,
  input: { objectiveScore: number; recitationScore: number; passed: boolean }
): Promise<Exam> {
  await ensureReady()
  const exam = await requireExam(examId)
  if (exam.status === 'graded') return exam

  const day = get<Row>('SELECT * FROM day WHERE id = ?', [exam.dayId])
  if (!day) throw new AppError('NOT_FOUND', 'Day 不存在')
  const goalId = s(day.goal_id)
  const planId = s(day.plan_id)
  const dayIdx = Math.round(n(day.idx))
  const dayTitle = s(day.title)
  const before = percentOfGoal(goalId)

  const objectiveScore = clamp(n(input.objectiveScore), 0, SCORING.objectiveTotal)
  const recitationScore = clamp(n(input.recitationScore), 0, SCORING.recitationTotal)
  const totalScore = Math.round((objectiveScore + recitationScore) * 10) / 10
  const passed = totalScore >= SCORING.passLine
  const previousStatus = toDayStatus(day.status)

  let progress: number
  let status: DayStatus
  if (passed) {
    progress = 1
    status = 'passed'
  } else if (totalScore >= SCORING.partialLine) {
    progress = SCORING.partialCredit
    status = 'partial'
  } else {
    progress = 0
    status = 'failed'
  }

  const at = iso()
  transaction(() => {
    run(
      `UPDATE exam SET status = 'graded', objective_score = ?, recitation_score = ?, total_score = ?, passed = ?, graded_at = ?
        WHERE id = ?`,
      [objectiveScore, recitationScore, totalScore, boolParam(passed), at, examId]
    )
    run('UPDATE day SET status = ?, progress = ?, score = ? WHERE id = ?', [
      status,
      progress,
      totalScore,
      exam.dayId
    ])

    // 通过 / 部分通过后解锁下一天
    if (status === 'passed' || status === 'partial') {
      const next = get<Row>(
        'SELECT * FROM day WHERE plan_id = ? AND idx > ? ORDER BY idx ASC LIMIT 1',
        [planId, dayIdx]
      )
      if (next && toDayStatus(next.status) === 'locked') {
        run(`UPDATE day SET status = 'learning' WHERE id = ?`, [s(next.id)])
      }
    }

    const after = percentOfGoal(goalId)
    const delta = round1(after - before)
    if (status !== previousStatus) {
      const reason: ProgressEvent['reason'] = status === 'passed' ? 'day_passed' : 'day_partial'
      const scoreText = `第 ${dayIdx} 天《${dayTitle}》总分 ${totalScore} 分`
      const detail =
        status === 'passed'
          ? `${scoreText}，通过（客观 ${objectiveScore} + 复述 ${recitationScore}）`
          : status === 'partial'
            ? `${scoreText}，部分通过（≥${SCORING.partialLine} 分），可重考刷新成绩`
            : `${scoreText}，未通过（<${SCORING.partialLine} 分），建议复习后重考`
      insertProgressEventRow(goalId, exam.dayId, delta, reason, detail)
    }
  })

  persist()
  pushProgress(goalId)
  return requireExam(examId)
}

// ───────────────────────────── Recitation ─────────────────────────────

export async function insertRecitation(
  examId: string,
  prompt: string,
  keyPoints: readonly string[]
): Promise<RecitationTask> {
  await ensureReady()
  const exam = await requireExam(examId)
  const id = nowId()
  const at = iso()
  const text = String(prompt ?? '').trim()
  if (text === '') throw new AppError('VALIDATION', '复述题面不能为空')
  run(
    `INSERT INTO recitation (id, exam_id, day_id, prompt, key_points, messages, follow_up, status, dimensions, score, feedback, critical_gap, created_at, graded_at)
     VALUES (?, ?, ?, ?, ?, '[]', NULL, 'awaiting_explain', NULL, NULL, NULL, NULL, ?, NULL)`,
    [id, examId, exam.dayId, text, JSON.stringify(keyPoints.filter((p) => p.trim() !== '')), at]
  )
  persist()
  const row = get<Row>('SELECT * FROM recitation WHERE id = ?', [id])
  if (!row) throw new AppError('DB', '创建复述题失败')
  return { ...toRecitationTask(row), keyPoints: stringList(row.key_points) }
}

export async function getRecitation(id: string): Promise<RecitationView> {
  await ensureReady()
  const row = get<Row>('SELECT * FROM recitation WHERE id = ?', [id])
  if (!row) throw new AppError('NOT_FOUND', '复述题不存在')
  return toRecitationView(row)
}

export async function getRecitationByExam(examId: string): Promise<RecitationTask | null> {
  await ensureReady()
  const row = get<Row>('SELECT * FROM recitation WHERE exam_id = ? ORDER BY created_at DESC LIMIT 1', [examId])
  return row ? toRecitationTask(row) : null
}

/** 仅主进程内部使用：拿隐藏要点，绝不下发前端 */
export async function getRecitationKeyPoints(id: string): Promise<string[]> {
  await ensureReady()
  const row = get<Row>('SELECT key_points FROM recitation WHERE id = ?', [id])
  return row ? stringList(row.key_points) : []
}

export interface RecitationPatch {
  status?: RecitationStatus
  messages?: readonly RecitationMessage[]
  followUp?: string | null
  dimensions?: RecitationDimensions | null
  score?: number | null
  feedback?: string | null
  criticalGap?: string | null
  gradedAt?: string | null
}

export async function updateRecitation(id: string, patch: RecitationPatch): Promise<RecitationView> {
  await ensureReady()
  const row = get<Row>('SELECT id FROM recitation WHERE id = ?', [id])
  if (!row) throw new AppError('NOT_FOUND', '复述题不存在')

  const sets: string[] = []
  const params: (string | number | null)[] = []

  if (patch.status !== undefined) {
    sets.push('status = ?')
    params.push(toRecitationStatus(patch.status))
  }
  if (patch.messages !== undefined) {
    sets.push('messages = ?')
    params.push(JSON.stringify(patch.messages))
  }
  if (patch.followUp !== undefined) {
    sets.push('follow_up = ?')
    params.push(patch.followUp)
  }
  if (patch.dimensions !== undefined) {
    sets.push('dimensions = ?')
    params.push(patch.dimensions === null ? null : JSON.stringify(patch.dimensions))
  }
  if (patch.score !== undefined) {
    sets.push('score = ?')
    params.push(patch.score)
  }
  if (patch.feedback !== undefined) {
    sets.push('feedback = ?')
    params.push(patch.feedback)
  }
  if (patch.criticalGap !== undefined) {
    sets.push('critical_gap = ?')
    params.push(patch.criticalGap)
  }
  if (patch.gradedAt !== undefined) {
    sets.push('graded_at = ?')
    params.push(patch.gradedAt)
  }

  if (sets.length > 0) {
    params.push(id)
    run(`UPDATE recitation SET ${sets.join(', ')} WHERE id = ?`, params)
    persist()
  }
  return getRecitation(id)
}

// ───────────────────────────── AI 用量 ─────────────────────────────

export interface AiUsageInput {
  scene: string
  model: string
  promptTokens: number
  completionTokens: number
  cacheHitTokens: number
  cost: number
  latencyMs: number
  ok: boolean
}

export async function logAiUsage(row: AiUsageInput): Promise<void> {
  await ensureReady()
  run(
    `INSERT INTO ai_usage (id, scene, model, prompt_tokens, completion_tokens, cache_hit_tokens, cost, latency_ms, ok, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      nowId(),
      String(row.scene ?? 'unknown'),
      String(row.model ?? MODEL_ID),
      Math.max(0, Math.round(n(row.promptTokens))),
      Math.max(0, Math.round(n(row.completionTokens))),
      Math.max(0, Math.round(n(row.cacheHitTokens))),
      Math.max(0, n(row.cost)),
      Math.max(0, Math.round(n(row.latencyMs))),
      boolParam(row.ok !== false),
      iso()
    ]
  )
  persist()
}

// ───────────────────────────── 导出 Markdown ─────────────────────────────

function safeFileName(input: string): string {
  return input.replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 60) || 'studyflow'
}

export async function exportMarkdown(goalId: string): Promise<{ path: string }> {
  await ensureReady()
  const goal = await getGoal(goalId)
  if (!goal) throw new AppError('NOT_FOUND', '学习目标不存在')

  const summary = await getProgressSummary(goalId)
  const plan = currentPlanRow(goalId)
  const days = plan ? await listDays(s(plan.id)) : []
  const events = await listProgressEvents(goalId, 100)

  const lines: string[] = []
  lines.push(`# ${goal.title}`)
  lines.push('')
  lines.push(`> 由 StudyFlow 导出 · ${new Date().toLocaleString('zh-CN')}`)
  lines.push('')
  lines.push(`- 总进度：**${summary.percent}%**（通过 ${summary.passedDays} / ${summary.totalDays} 天）`)
  lines.push(`- 每日投入：约 ${goal.dailyMinutes} 分钟`)
  if (goal.targetDate) lines.push(`- 目标日期：${goal.targetDate}`)
  if (goal.description.trim()) {
    lines.push('')
    lines.push('## 目标描述')
    lines.push('')
    lines.push(goal.description.trim())
  }

  if (plan) {
    lines.push('')
    lines.push(`## 学习计划：${s(plan.title)}`)
    lines.push('')
    for (const day of days) {
      const mark = day.status === 'passed' ? '✅' : day.status === 'partial' ? '🟡' : day.status === 'failed' ? '❌' : '⬜'
      lines.push(`### ${mark} Day ${day.index} · ${day.title}（${day.estMinutes} 分钟）`)
      if (day.goal.trim()) lines.push(`> ${day.goal.trim()}`)
      lines.push('')
      for (const task of day.tasks) {
        const box = task.status === 'done' ? '[x]' : task.status === 'skipped' ? '[-]' : '[ ]'
        lines.push(`- ${box} ${task.title}（${task.estMinutes} 分钟）`)
      }
      if (day.checkpoints.length > 0) {
        lines.push('')
        lines.push('检查点：')
        for (const point of day.checkpoints) lines.push(`- ${point}`)
      }
      if (day.score !== null) {
        lines.push('')
        lines.push(`**得分：${day.score}**`)
      }
      lines.push('')
    }
  }

  if (events.length > 0) {
    lines.push('## 进度记录')
    lines.push('')
    lines.push('| 时间 | 变化 | 说明 |')
    lines.push('| --- | --- | --- |')
    for (const event of events) {
      const sign = event.delta > 0 ? `+${event.delta}` : String(event.delta)
      lines.push(
        `| ${new Date(event.createdAt).toLocaleString('zh-CN')} | ${sign}% | ${event.detail.replace(/\|/g, '/')} |`
      )
    }
    lines.push('')
  }

  const file = join(exportDir(), `${safeFileName(goal.title)}-${Date.now()}.md`)
  writeFileSync(file, lines.join('\n'), 'utf8')
  logger.info('repo', `已导出 Markdown: ${file}`)
  return { path: file }
}
