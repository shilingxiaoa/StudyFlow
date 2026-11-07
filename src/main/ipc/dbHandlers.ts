/**
 * 数据类通道：不花 token 的全部能力都在这。
 * 约定：所有入参都用 db/payload.ts 做容错解析（裸字符串 / { id } / { goalId } 都能吃），
 * 所有返回都是 contracts.ts 里定义的类型，字段名一个都不能改。
 */
import type {
  AppSettings,
  DayDetail,
  ExamObjectiveResult,
  ExamPayload,
  Goal,
  GoalInput,
  GoalKind,
  GoalLevel,
  MaterialImportResult,
  PlanSummary,
  RecitationTask,
  TaskStatus
} from '../../shared/contracts'
import { app, dialog } from 'electron'
import { isAbsolute, basename, resolve } from 'node:path'
import { IPC } from '../../shared/contracts'
import { handle } from './handle'
import { AppError } from './handle'
import * as repo from '../db/repo'
import type { GoalPatch } from '../db/repo'
import { flushSync } from '../db/database'
import { asRecord, pickNumber, pickObject, pickString, readId, requireId, requireString } from '../db/payload'
import { logger } from '../util/logger'
import { MAX_FILES, parseDocument } from '../util/importer'

const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'done', 'skipped']

/** 去掉 keyPoints（隐藏要点永远不下发渲染进程） */
export function stripKeyPoints(task: RecitationTask): RecitationTask {
  const { keyPoints: _ignored, ...rest } = task
  return rest
}

function settingsPatch(payload: unknown): Partial<AppSettings> {
  const nested = pickObject(payload, 'patch', 'settings', 'data')
  const source = nested ?? asRecord(payload)
  const patch: Record<string, unknown> = {}
  const keys = [
    'theme',
    'dailyMinutes',
    'remindEnabled',
    'remindTime',
    'reviewEnabled',
    'reviewEveryDays',
    'reviewEveryWeekdays',
    'baseUrl'
  ] as const
  for (const key of keys) {
    if (source[key] !== undefined) patch[key] = source[key]
  }
  return patch as Partial<AppSettings>
}

function goalInput(payload: unknown): GoalInput {
  const nested = pickObject(payload, 'goal', 'input', 'data')
  const source = nested ?? asRecord(payload)
  return {
    title: pickString(source, 'title', 'name') ?? '',
    description: pickString(source, 'description', 'desc') ?? '',
    kind: (pickString(source, 'kind') ?? 'exam') as GoalKind,
    level: (pickString(source, 'level') ?? 'zero') as GoalLevel,
    targetDate: pickString(source, 'targetDate', 'target_date'),
    dailyMinutes: pickNumber(source, 'dailyMinutes') ?? pickNumber(source, 'daily_minutes') ?? 60
  }
}

function goalPatch(payload: unknown): { id: string; patch: GoalPatch } {
  const id = requireId(payload, '目标 id', 'id', 'goalId')
  const nested = pickObject(payload, 'patch', 'data', 'input')
  const source = nested ?? asRecord(payload)
  const patch: Record<string, unknown> = {}

  const title = pickString(source, 'title', 'name')
  if (title !== null) patch.title = title
  if (source.description !== undefined) patch.description = String(source.description ?? '')
  if (source.kind !== undefined) patch.kind = String(source.kind)
  if (source.level !== undefined) patch.level = String(source.level)
  if (source.targetDate !== undefined) patch.targetDate = source.targetDate === null ? null : String(source.targetDate)
  else if (source.target_date !== undefined) {
    patch.targetDate = source.target_date === null ? null : String(source.target_date)
  }
  const daily = pickNumber(source, 'dailyMinutes') ?? pickNumber(source, 'daily_minutes')
  if (daily !== undefined) patch.dailyMinutes = daily
  if (source.archived !== undefined) patch.archived = source.archived === true
  return { id, patch: patch as GoalPatch }
}

function requireTaskStatus(payload: unknown): TaskStatus {
  const raw = String(readId(payload, 'status') ?? '').trim()
  const text = (raw || (pickString(payload, 'status') ?? '')).trim()
  if ((TASK_STATUSES as readonly string[]).includes(text)) return text as TaskStatus
  throw new AppError('VALIDATION', `任务状态不合法：${text || '(空)'}`)
}

let quitHookInstalled = false

/** 退出前同步落盘：index.ts 不允许改，所以钩子在这里注册（registerDbHandlers 在 whenReady 时被调用） */
function installQuitHook(): void {
  if (quitHookInstalled) return
  quitHookInstalled = true
  app.on('before-quit', () => {
    try {
      flushSync()
    } catch (err) {
      logger.warn('db', '退出前写盘失败', err)
    }
  })
}

export function registerDbHandlers(): void {
  installQuitHook()

  // ───────── 启动 / 设置 ─────────
  handle<unknown, Awaited<ReturnType<typeof repo.getBootstrap>>>(IPC.APP_BOOTSTRAP, () => repo.getBootstrap())

  handle<unknown, AppSettings>(IPC.SETTINGS_GET, () => repo.getSettings())

  handle<unknown, AppSettings>(IPC.SETTINGS_UPDATE, (payload) => repo.updateSettings(settingsPatch(payload)))

  handle<unknown, AppSettings>(IPC.SETTINGS_SET_KEY, async (payload) => {
    const direct = typeof payload === 'string' ? payload : null
    const key = direct ?? pickString(payload, 'apiKey', 'key', 'value') ?? ''
    await repo.setApiKey(key)
    return repo.getSettings()
  })

  // ───────── 目标 ─────────
  handle<unknown, Goal[]>(IPC.GOAL_LIST, (payload) => {
    const includeArchived = asRecord(payload).includeArchived === true
    return repo.listGoals(includeArchived)
  })

  handle<unknown, Goal>(IPC.GOAL_CREATE, (payload) => repo.createGoal(goalInput(payload)))

  handle<unknown, Goal>(IPC.GOAL_UPDATE, (payload) => {
    const { id, patch } = goalPatch(payload)
    return repo.updateGoal(id, patch)
  })

  handle<unknown, { id: string }>(IPC.GOAL_DELETE, async (payload) => {
    const id = requireId(payload, '目标 id', 'id', 'goalId')
    await repo.deleteGoal(id)
    return { id }
  })

  // ───────── 计划 ─────────
  handle<unknown, PlanSummary[]>(IPC.PLAN_LIST, (payload) => {
    const goalId = readId(payload, 'goalId', 'id')
    return repo.listPlans(goalId === '' ? undefined : goalId)
  })

  handle<unknown, { id: string }>(IPC.PLAN_DELETE, async (payload) => {
    const id = requireId(payload, '计划 id', 'id', 'planId')
    await repo.deletePlan(id)
    return { id }
  })

  handle<unknown, Awaited<ReturnType<typeof repo.updatePlan>>>(IPC.PLAN_UPDATE, (payload) => {
    const record = asRecord(payload)
    const planId = requireId(payload, '计划 id', 'planId', 'id')
    const input: {
      planId: string
      title?: string
      totalDays?: number
    } = { planId }
    if ('title' in record && record.title !== null && record.title !== undefined) {
      input.title = String(record.title)
    }
    if ('totalDays' in record && record.totalDays !== null && record.totalDays !== undefined) {
      const value = Number(record.totalDays)
      if (!Number.isFinite(value)) throw new AppError('VALIDATION', '计划天数要填数字')
      input.totalDays = Math.round(value)
    }
    return repo.updatePlan(input)
  })

  handle<unknown, Awaited<ReturnType<typeof repo.setActiveContext>>>(IPC.CONTEXT_SET, (payload) => {
    const record = asRecord(payload)
    // 字段缺省 = 不变；显式 null /空串 = 清空
    const input: { goalId?: string | null; planId?: string | null } = {}
    if ('goalId' in record) {
      const value = record.goalId
      input.goalId = value === null || value === undefined ? null : String(value)
    }
    if ('planId' in record) {
      const value = record.planId
      input.planId = value === null || value === undefined ? null : String(value)
    }
    return repo.setActiveContext(input)
  })

  handle<unknown, Awaited<ReturnType<typeof repo.savePlan>>>(IPC.PLAN_SAVE, async (payload) => {
    // 兼容两种入参：{ goalId, plan } 与文档里的裸 GeneratedPlan（无 goalId 时回退到最近创建的目标）
    let goalId = readId(payload, 'goalId')
    const nested = pickObject(payload, 'plan', 'generated', 'data')
    const source = nested ?? asRecord(payload)
    const days = source.days
    if (!Array.isArray(days) || days.length === 0) {
      throw new AppError('VALIDATION', '计划内容为空：缺少 days')
    }
    if (goalId === '') {
      const goals = await repo.listGoals()
      if (goals.length === 0) throw new AppError('VALIDATION', '请先创建学习目标，再保存计划')
      goalId = goals[0].id
    }
    return repo.savePlan(goalId, source as unknown as Parameters<typeof repo.savePlan>[1])
  })

  // ───────── Day / Task ─────────
  handle<unknown, Awaited<ReturnType<typeof repo.listDays>>>(IPC.DAY_LIST, async (payload) => {
    // 兼容 { planId } 与 { goalId }（后者取该目标最近的计划）
    let planId = readId(payload, 'planId')
    if (planId === '') {
      const goalId = readId(payload, 'goalId', 'id')
      if (goalId === '') throw new AppError('VALIDATION', '缺少计划 id')
      const plans = await repo.listPlans(goalId)
      planId = plans[0]?.id ?? ''
      if (planId === '') throw new AppError('NOT_FOUND', '这个目标还没有学习计划')
    }
    return repo.listDays(planId)
  })

  handle<unknown, DayDetail>(IPC.DAY_GET, async (payload) => {
    const dayId = requireId(payload, 'Day id', 'dayId', 'id')
    const day = await repo.getDayDetail(dayId)
    if (!day) throw new AppError('NOT_FOUND', '这一天不存在')
    return day
  })

  handle<unknown, DayDetail>(IPC.TASK_SET_STATUS, (payload) => {
    const taskId = requireId(payload, '任务 id', 'taskId', 'id')
    const status = requireTaskStatus(payload)
    return repo.setTaskStatus(taskId, status)
  })

  // ───────── 考试（客观题本地判分，不花 token） ─────────
  handle<unknown, ExamPayload>(IPC.EXAM_GET, async (payload) => {
    let examId = readId(payload, 'examId', 'id')
    if (examId === '') {
      const dayId = readId(payload, 'dayId')
      if (dayId !== '') {
        const day = await repo.getDayWithTasks(dayId)
        examId = day?.examId ?? ''
      }
    }
    if (examId === '') throw new AppError('VALIDATION', '缺少考试 id')
    const exam = await repo.getExam(examId)
    if (!exam) throw new AppError('NOT_FOUND', '考试不存在')
    const questions = await repo.listQuestions(examId)
    const recitation = await repo.getRecitationByExam(examId)
    if (!recitation) throw new AppError('NOT_FOUND', '这次考试还没有问答题')
    return { exam, questions, recitation: stripKeyPoints(recitation) }
  })

  handle<unknown, ExamObjectiveResult>(IPC.EXAM_SUBMIT_OBJECTIVE, (payload) => {
    const examId = requireId(payload, '考试 id', 'examId', 'id')
    // 整个 payload 交给 repo：它同时兼容 { answers:{...} } / [{questionId,answer}] / { [qid]: value }
    return repo.submitObjective(examId, payload)
  })

  // ───────── 进度 ─────────
  handle<unknown, Awaited<ReturnType<typeof repo.getProgressSummary>>>(IPC.PROGRESS_SUMMARY, (payload) => {
    const goalId = requireId(payload, '目标 id', 'goalId', 'id')
    return repo.getProgressSummary(goalId)
  })

  handle<unknown, Awaited<ReturnType<typeof repo.listProgressEvents>>>(IPC.PROGRESS_EVENTS, (payload) => {
    const goalId = requireId(payload, '目标 id', 'goalId', 'id')
    const limit = pickNumber(payload, 'limit') ?? 50
    return repo.listProgressEvents(goalId, limit)
  })

  // ───────── 资料 ─────────
  handle<unknown, Awaited<ReturnType<typeof repo.listMaterials>>>(IPC.MATERIAL_LIST, (payload) => {
    const goalId = requireId(payload, '目标 id', 'goalId', 'id')
    return repo.listMaterials(goalId)
  })

  handle<unknown, Awaited<ReturnType<typeof repo.addMaterial>>>(IPC.MATERIAL_ADD, (payload) => {
    const goalId = requireId(payload, '目标 id', 'goalId', 'id')
    const nested = pickObject(payload, 'material', 'data')
    const source = nested ?? asRecord(payload)
    return repo.addMaterial({
      goalId,
      title: pickString(source, 'title') ?? '',
      kind: (pickString(source, 'kind') ?? 'text') as Parameters<typeof repo.addMaterial>[0]['kind'],
      content: requireString(source, 'content', '资料内容')
    })
  })

  handle<unknown, { id: string }>(IPC.MATERIAL_DELETE, async (payload) => {
    const id = requireId(payload, '资料 id', 'id', 'materialId')
    await repo.deleteMaterial(id)
    return { id }
  })

  /**
   * 弹系统文件框选 .md/.txt/.docx/.pptx → 解析成纯文本 → 逐份入库。
   * .pptx 会连同「备注」一起抽出来（讲稿通常比幻灯片本身信息更多）。
   * 也接受显式 paths（自动化测试用），否则一律走系统对话框，渲染进程拿不到任意路径读取能力。
   */
  handle<unknown, MaterialImportResult>(IPC.MATERIAL_IMPORT, async (payload) => {
    const goalId = requireId(payload, '目标 id', 'goalId', 'id')
    const record = asRecord(payload)
    const explicit = Array.isArray(record?.paths)
      ? (record.paths as unknown[]).map((item) => String(item ?? '').trim()).filter((item) => item !== '')
      : null

    let files: string[] = []
    if (explicit !== null) {
      files = explicit
    } else {
      const picked = await dialog.showOpenDialog({
        title: '选择学习资料',
        buttonLabel: '导入',
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: '学习资料（Markdown / 文本 / Word / PowerPoint）',
            extensions: ['md', 'markdown', 'txt', 'docx', 'pptx']
          },
          { name: '全部文件', extensions: ['*'] }
        ]
      })
      if (picked.canceled || picked.filePaths.length === 0) {
        return { materials: await repo.listMaterials(goalId), imported: 0, skipped: [] }
      }
      files = picked.filePaths
    }

    const skipped: { name: string; reason: string }[] = []
    let imported = 0
    for (const rawPath of files.slice(0, MAX_FILES)) {
      // 相对路径按进程工作目录解析（自动化测试传的就是相对路径）。
      // 不能用 app.getAppPath()：打包后它是 resources/app.asar，相对路径会被解析到 asar 内部。
      const filePath = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath)
      try {
        const parsed = await parseDocument(filePath)
        await repo.addMaterial({ goalId, title: parsed.title, kind: parsed.kind, content: parsed.content })
        imported += 1
      } catch (err) {
        const message = err instanceof AppError ? err.message : '解析失败，已跳过'
        logger.warn('material', `导入失败 ${basename(filePath)}: ${message}`)
        skipped.push({ name: basename(filePath), reason: message })
      }
    }
    if (files.length > MAX_FILES) {
      skipped.push({
        name: `另外 ${files.length - MAX_FILES} 个文件`,
        reason: `一次最多导入 ${MAX_FILES} 份`
      })
    }
    return { materials: await repo.listMaterials(goalId), imported, skipped }
  })

  // ───────── 统计 / 导出 ─────────
  handle<unknown, Awaited<ReturnType<typeof repo.getStatsOverview>>>(IPC.STATS_OVERVIEW, () =>
    repo.getStatsOverview()
  )

  handle<unknown, { path: string }>(IPC.EXPORT_MARKDOWN, (payload) => {
    const goalId = requireId(payload, '目标 id', 'goalId', 'id')
    return repo.exportMarkdown(goalId)
  })
}
