/**
 * AI 类通道：所有会花 token 的能力都在这，统一是「先 assertApiKey → 调 AI → 落库 → 返回契约类型」。
 * 评分折算、通过判定一律在主进程完成（模型只给 0–1 的维度达成度）。
 */
import type {
  Exam,
  ExamGradeResult,
  ExamObjectiveResult,
  ExamPayload,
  GeneratedPlan,
  Lesson,
  LessonAskResult,
  RecitationMessage,
  RecitationView,
  ReviewPayload,
  ReviewResult
} from '../../shared/contracts'
import { IPC, SCORING } from '../../shared/contracts'
import { AppError, handle } from './handle'
import * as repo from '../db/repo'
import { asRecord, pickObject, pickString, readId, requireId, requireString } from '../db/payload'
import { charCount, judgeQuestion } from '../db/answer'
import { assertApiKey, testApiKey } from '../ai/client'
import { generatePlan } from '../ai/planner'
import { askLesson, generateLesson } from '../ai/teacher'
import { generateExam } from '../ai/examiner'
import { buildAdvice, gradeRecitation } from '../ai/grader'
import { generateFollowUp } from '../ai/feynman'
import { stripKeyPoints } from './dbHandlers'

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

const MATERIAL_EXCERPT_LIMIT = 4_000

/** 资料拼给模型用：每份截断，总量截断，避免超长 prompt */
function materialExcerpt(materials: readonly { title: string; content: string }[]): string {
  if (materials.length === 0) return ''
  return materials
    .map((item) => `《${item.title || '未命名资料'}》\n${String(item.content ?? '').trim()}`)
    .join('\n\n')
    .slice(0, MATERIAL_EXCERPT_LIMIT)
}

/** 问答题定位：认 recitationId，也认 examId（问答题由 exam 反查） */
async function recitationViewFromPayload(payload: unknown): Promise<RecitationView> {
  const recitationId = readId(payload, 'recitationId', 'id')
  if (recitationId !== '') return repo.getRecitation(recitationId)

  const examId = requireId(payload, '考试 id', 'examId')
  const task = await repo.getRecitationByExam(examId)
  if (!task) throw new AppError('NOT_FOUND', '这次考试还没有问答题')
  return repo.getRecitation(task.id)
}

/** 复检答案：支持数组 / 映射 / { answers: ... } 三种形态 */
function collectAnswers(payload: unknown): Map<string, string> {
  const container = pickObject(payload, 'answers', 'answerMap')
  const source: unknown = container ?? asRecord(payload)
  const out = new Map<string, string>()

  if (Array.isArray(source)) {
    for (const item of source) {
      const row = asRecord(item)
      const questionId = readId(row, 'questionId', 'id')
      const answer = pickString(row, 'answer', 'value', 'userAnswer') ?? ''
      if (questionId !== '') out.set(questionId, answer)
    }
    return out
  }

  for (const [key, value] of Object.entries(asRecord(source))) {
    if (key === 'goalId' || key === 'answers' || key === 'answerMap') continue
    if (typeof value === 'string' || typeof value === 'number') {
      out.set(key, String(value))
      continue
    }
    if (value !== null && typeof value === 'object') {
      const row = asRecord(value)
      const questionId = readId(row, 'questionId', 'id') || key
      const answer = pickString(row, 'answer', 'value', 'userAnswer') ?? ''
      if (questionId !== '') out.set(questionId, answer)
    }
  }
  return out
}

export function registerAiHandlers(): void {
  /** 同一天同时点两次「备课」只跑一次 */
  const lessonInflight = new Map<string, Promise<Lesson>>()

  // ───────── 每日教案：读 / 生成 / 答疑 ─────────
  handle<unknown, Lesson>(IPC.LESSON_GET, async (payload) => {
    const dayId = requireId(payload, 'Day id', 'dayId', 'id')
    const day = await repo.getDayDetail(dayId)
    if (!day) throw new AppError('NOT_FOUND', '这一天不存在')
    return repo.getLesson(dayId)
  })

  handle<unknown, Lesson>(IPC.LESSON_GENERATE, async (payload) => {
    const dayId = requireId(payload, 'Day id', 'dayId', 'id')
    const force = asRecord(payload).force === true
    const day = await repo.getDayDetail(dayId)
    if (!day) throw new AppError('NOT_FOUND', '这一天不存在')

    // 已经备过课就直接返回缓存，避免重复花钱；前端要重讲时传 force: true
    if (!force) {
      const cached = await repo.getLesson(dayId)
      if (cached.status === 'ready' && cached.sections.length > 0) return cached
    }

    const running = lessonInflight.get(dayId)
    if (running) return running

    const job = (async (): Promise<Lesson> => {
      try {
        await assertApiKey()
        await repo.setLessonStatus(dayId, 'generating')
        const goal = await repo.getGoal(day.goalId)
        if (!goal) throw new AppError('NOT_FOUND', '学习目标不存在')
        const materials = await repo.listMaterials(day.goalId)
        const draft = await generateLesson({ goal, day, materials })
        return await repo.saveLesson(dayId, draft)
      } catch (error) {
        const message =
          error instanceof AppError ? error.message : '生成教案失败，请检查网络后重试'
        await repo.setLessonStatus(dayId, 'failed', message)
        throw error
      } finally {
        lessonInflight.delete(dayId)
      }
    })()

    lessonInflight.set(dayId, job)
    return job
  })

  handle<unknown, LessonAskResult>(IPC.LESSON_ASK, async (payload) => {
    const dayId = requireId(payload, 'Day id', 'dayId', 'id')
    const question = requireString(payload, 'question', '问题').trim()
    if (Array.from(question).length < 2) throw new AppError('VALIDATION', '问题太短了，再写具体一点')
    if (Array.from(question).length > 500) throw new AppError('VALIDATION', '问题太长了，请压缩到 500 字以内')

    const day = await repo.getDayDetail(dayId)
    if (!day) throw new AppError('NOT_FOUND', '这一天不存在')
    const lesson = await repo.getLesson(dayId)
    if (lesson.status !== 'ready' || lesson.sections.length === 0) {
      throw new AppError('VALIDATION', '这一天的教案还没生成，先让 AI 备课再来提问')
    }

    await assertApiKey()
    const materials = await repo.listMaterials(day.goalId)
    const answer = await askLesson({
      goalTitle: day.goalTitle,
      dayTitle: day.title,
      lesson,
      materials,
      question
    })
    return { answer }
  })

  // ───────── 设置：验证 Key ─────────
  handle<unknown, { ok: true; latencyMs: number }>(IPC.SETTINGS_TEST_KEY, async () => {
    await assertApiKey()
    return testApiKey()
  })

  // ───────── 计划生成 ─────────
  handle<unknown, GeneratedPlan>(IPC.PLAN_GENERATE, async (payload) => {
    await assertApiKey()
    const goalId = requireId(payload, '目标 id', 'goalId', 'id')
    const goal = await repo.getGoal(goalId)
    if (!goal) throw new AppError('NOT_FOUND', '学习目标不存在')
    const materials = await repo.listMaterials(goalId)
    return generatePlan(goal, materials)
  })

  // ───────── 考试：出题（隐藏要点绝不下发） ─────────
  handle<unknown, ExamPayload>(IPC.EXAM_CREATE, async (payload) => {
    await assertApiKey()
    const dayId = requireId(payload, 'Day id', 'dayId', 'id')
    const day = await repo.getDayDetail(dayId)
    if (!day) throw new AppError('NOT_FOUND', '这一天不存在')
    // 守卫：Day 的任务必须全部完成（learning = 还有没做的任务；locked = 还没解锁）
    if (day.status === 'locked') throw new AppError('VALIDATION', '这一天还没解锁，先完成前面的 Day')
    if (day.status === 'learning') {
      throw new AppError('VALIDATION', '这一天的任务还没全部完成，先做完任务再发起检测')
    }

    const materials = await repo.listMaterials(day.goalId)
    const draft = await generateExam(day, materialExcerpt(materials))

    const exam = await repo.insertExam(dayId)
    const questions = await repo.insertQuestions(dayId, exam.id, draft.questions)
    const recitation = await repo.insertRecitation(exam.id, draft.recitation.prompt, draft.recitation.keyPoints)
    return { exam, questions, recitation: stripKeyPoints(recitation) }
  })

  // ───────── 问答（第一个问题 + 追问） ─────────
  handle<unknown, RecitationView>(IPC.RECITATION_START, async (payload) => recitationViewFromPayload(payload))

  handle<unknown, RecitationView>(IPC.RECITATION_SAY, async (payload) => {
    const view = await recitationViewFromPayload(payload)
    if (view.status === 'graded') throw new AppError('VALIDATION', '这次问答已经评分完成')
    if (view.followUp) throw new AppError('VALIDATION', 'AI 已经提出追问了，请直接回答后提交')

    const text = requireString(payload, 'text', '回答内容')
    const count = charCount(text)
    if (count < SCORING.minAnswerChars) {
      throw new AppError(
        'VALIDATION',
        `回答至少 ${SCORING.minAnswerChars} 字（当前 ${count} 字），一两句话就够`
      )
    }

    await assertApiKey()
    const exam = await repo.getExam(view.examId)
    if (!exam) throw new AppError('NOT_FOUND', '考试不存在')
    const day = await repo.getDayDetail(exam.dayId)
    if (!day) throw new AppError('NOT_FOUND', '这一天不存在')
    const keyPoints = await repo.getRecitationKeyPoints(view.id)

    const followUp = await generateFollowUp({
      day: { index: day.index, title: day.title, goal: day.goal, checkpoints: day.checkpoints },
      topicPrompt: view.prompt,
      explainText: text,
      keyPoints
    })

    const at = new Date().toISOString()
    const messages: RecitationMessage[] = [
      ...view.messages,
      { role: 'user', text, at },
      { role: 'student', text: followUp, at }
    ]
    return repo.updateRecitation(view.id, { status: 'awaiting_followup_answer', messages, followUp })
  })

  handle<unknown, ExamGradeResult>(IPC.RECITATION_SUBMIT, async (payload) => {
    const view = await recitationViewFromPayload(payload)
    if (view.status === 'graded') throw new AppError('VALIDATION', '这次问答已经评分完成')
    if (!view.followUp) throw new AppError('VALIDATION', '请先回答第一个问题，等 AI 追问后再提交评分')

    const answerText = pickString(payload, 'text', 'answer')?.trim() ?? ''
    if (answerText === '') throw new AppError('VALIDATION', '请先回答追问，再提交评分')
    const count = charCount(answerText)
    if (count < SCORING.minFollowupChars) {
      throw new AppError(
        'VALIDATION',
        `追问回答至少 ${SCORING.minFollowupChars} 字（当前 ${count} 字）`
      )
    }

    await assertApiKey()
    const examBefore = await repo.getExam(view.examId)
    if (!examBefore) throw new AppError('NOT_FOUND', '考试不存在')
    if (examBefore.status === 'graded') throw new AppError('VALIDATION', '这次考试已经结算过了')
    if (examBefore.objectiveScore === null) {
      throw new AppError('VALIDATION', '请先提交客观题答案，再提交问答评分')
    }
    const day = await repo.getDayDetail(examBefore.dayId)
    if (!day) throw new AppError('NOT_FOUND', '这一天不存在')
    const keyPoints = await repo.getRecitationKeyPoints(view.id)

    const at = new Date().toISOString()
    const messages: RecitationMessage[] = [...view.messages, { role: 'user', text: answerText, at }]
    const pending = await repo.updateRecitation(view.id, { status: 'grading', messages })

    let grade: Awaited<ReturnType<typeof gradeRecitation>>
    try {
      grade = await gradeRecitation({
        day: { index: day.index, title: day.title, goal: day.goal, checkpoints: day.checkpoints },
        recitation: { prompt: pending.prompt, followUp: pending.followUp, messages: pending.messages },
        keyPoints
      })
    } catch (error) {
      // 评分失败回退状态，允许用户重试
      await repo
        .updateRecitation(view.id, { status: 'awaiting_followup_answer' })
        .catch(() => undefined)
      throw error
    }

    const recitation = await repo.updateRecitation(view.id, {
      status: 'graded',
      dimensions: grade.dimensions,
      score: grade.score,
      feedback: grade.feedback,
      criticalGap: grade.criticalGap,
      gradedAt: new Date().toISOString()
    })

    const objectiveScore = examBefore.objectiveScore ?? 0
    const exam = await repo.finishExam(view.examId, {
      objectiveScore,
      recitationScore: grade.score,
      passed: false // 通过判定只在主进程按 passLine 算，这里传 false 不参与判定
    })
    const objective = await repo.getObjectiveDetail(view.examId)
    const passed = exam.passed === true
    const totalScore = exam.totalScore ?? round1(objectiveScore + grade.score)
    const advice = buildAdvice({
      dayIndex: day.index,
      totalScore,
      objectiveScore,
      recitationScore: grade.score,
      passed,
      criticalGap: recitation.criticalGap
    })

    return { exam, totalScore, passed, objective, recitation, advice }
  })

  // ───────── 复检 ─────────
  handle<unknown, ReviewPayload>(IPC.REVIEW_CREATE, async (payload) => {
    const goalId = requireId(payload, '目标 id', 'goalId', 'id')
    const goal = await repo.getGoal(goalId)
    if (!goal) throw new AppError('NOT_FOUND', '学习目标不存在')
    const questions = await repo.pickReviewQuestions(goalId, 2)
    if (questions.length === 0) {
      throw new AppError('NOT_FOUND', '还没有考过的学习日，暂时无法复检')
    }
    const dayIds = Array.from(new Set(questions.map((question) => question.dayId)))
    return { goalId, questions, dayIds }
  })

  handle<unknown, ReviewResult>(IPC.REVIEW_SUBMIT, async (payload) => {
    const answers = collectAnswers(payload)
    if (answers.size === 0) throw new AppError('VALIDATION', '缺少复检答案')
    const questions = await repo.getQuestionsByIds([...answers.keys()])
    if (questions.length === 0) throw new AppError('NOT_FOUND', '复检题目不存在')

    let goalId = readId(payload, 'goalId', 'id')
    if (goalId === '') goalId = (await repo.getDayDetail(questions[0].dayId))?.goalId ?? ''

    const perQuestion: ExamObjectiveResult['perQuestion'] = []
    let delta = 0

    for (const question of questions) {
      const judged = judgeQuestion(question, answers.get(question.id))
      perQuestion.push({
        questionId: question.id,
        correct: judged.correct,
        userAnswer: judged.userAnswer,
        answer: question.answer,
        explanation: question.explanation
      })
      if (judged.correct) continue
      const applied = await repo.applyDayProgressDelta(
        question.dayId,
        SCORING.reviewPenalty,
        'review_failed',
        `复检答错「${question.knowledgePoint || question.stem.slice(0, 24)}」，进度回退`
      )
      delta += applied.delta
    }

    const passed = perQuestion.every((item) => item.correct)
    let percent = 0
    if (goalId !== '') {
      if (passed && questions.length > 0) {
        await repo.appendProgressEvent(goalId, questions[0].dayId, 0, 'review_passed', `复检 ${questions.length} 题全部答对`)
      }
      percent = (await repo.getProgressSummary(goalId)).percent
    }

    return { passed, perQuestion, percent, delta: round1(delta) }
  })
}

/** 供内部复用（目前 aiHandlers 之外没人用，导出避免 noUnusedLocals） */
export type { Exam }
