/* ============================================================
   StudyFlow · 考试 + 费曼复述（#/exam/:examId）
   单页三步：客观题 → 费曼复述（讲解 + 学生追问）→ 结果
   ============================================================ */
import { useEffect, useState } from 'react'
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { IPC, SCORING } from '@shared/contracts'
import type {
  DayDetail,
  Exam,
  ExamGradeResult,
  ExamObjectiveResult,
  ExamPayload,
  Question,
  RecitationDimensions,
  RecitationView
} from '@shared/contracts'
import { Page } from '../components/layout'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  KeyHint,
  Skeleton,
  Spinner,
  TextArea
} from '../components/ui'
import { call } from '../lib/api'
import type { Tone } from '../lib/format'
import { navigate, useRoute } from '../lib/router'
import './Exam.css'

export interface ExamProps {
  /** 由 App 的 RouteView 传入；缺省时回落到 useRoute().params.examId */
  examId?: string
}

type Stage = 'objective' | 'recitation' | 'result'

const STEPS: { key: Stage; label: string }[] = [
  { key: 'objective', label: '客观题' },
  { key: 'recitation', label: '费曼复述' },
  { key: 'result', label: '结果' }
]

const DIMENSIONS: { key: keyof RecitationDimensions; label: string; hint: string; weight: number }[] = [
  { key: 'accuracy', label: '准确性', hint: '概念有没有说错', weight: SCORING.recitationWeights.accuracy },
  { key: 'coverage', label: '完整性', hint: '要点覆盖了几成', weight: SCORING.recitationWeights.coverage },
  { key: 'example', label: '举例', hint: '有没有自己的例子', weight: SCORING.recitationWeights.example },
  { key: 'clarity', label: '清晰度', hint: '结构清楚、不堆术语', weight: SCORING.recitationWeights.clarity }
]

function charCount(text: string): number {
  return Array.from(text).length
}

function optionLetter(index: number): string {
  return String.fromCharCode(65 + index)
}

/** 把答案值渲染成可读文本：单选存的是 0 起下标（也兼容字母 / 选项原文） */
function answerText(question: Question | undefined, value: string): string {
  if (!value || value.trim() === '') return '未作答'
  if (!question || question.type !== 'single_choice') return value
  const options = question.options ?? []
  const raw = value.trim()
  const numeric = Number(raw)
  if (Number.isInteger(numeric) && options[numeric] !== undefined) {
    return `${optionLetter(numeric)}. ${options[numeric]}`
  }
  if (raw.length === 1) {
    const index = raw.toUpperCase().charCodeAt(0) - 65
    if (index >= 0 && options[index] !== undefined) return `${optionLetter(index)}. ${options[index]}`
  }
  const matched = options.findIndex((option) => option.trim() === raw)
  if (matched >= 0) return `${optionLetter(matched)}. ${options[matched]}`
  return value
}

/** 标准答案是第几个选项（兼容 0 起下标 / 1 起 / 字母 / 选项原文） */
function correctIndex(question: Question, answer: string): number {
  const options = question.options ?? []
  const raw = answer.trim()
  const numeric = Number(raw)
  if (Number.isInteger(numeric)) {
    if (options[numeric] !== undefined) return numeric
    if (options[numeric - 1] !== undefined && numeric >= 1) return numeric - 1
  }
  if (raw.length === 1) {
    const index = raw.toUpperCase().charCodeAt(0) - 65
    if (index >= 0 && options[index] !== undefined) return index
  }
  return options.findIndex((option) => option.trim() === raw)
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(value, 0), 1)
}

function levelOf(score: number): { label: string; tone: Tone } {
  if (score >= SCORING.passLine) return { label: '通过', tone: 'success' }
  if (score >= SCORING.partialLine) return { label: '部分通过', tone: 'warn' }
  return { label: '未通过', tone: 'danger' }
}

export default function ExamPage({ examId }: ExamProps): JSX.Element {
  const route = useRoute()
  const currentExamId = examId || route.params.examId || ''

  const [stage, setStage] = useState<Stage>('objective')
  const [exam, setExam] = useState<Exam | null>(null)
  const [questions, setQuestions] = useState<Question[]>([])
  const [day, setDay] = useState<DayDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [objectiveError, setObjectiveError] = useState<unknown>(null)
  const [objectiveResult, setObjectiveResult] = useState<ExamObjectiveResult | null>(null)

  const [view, setView] = useState<RecitationView | null>(null)
  const [viewLoading, setViewLoading] = useState(false)
  const [viewError, setViewError] = useState<unknown>(null)
  const [explainText, setExplainText] = useState('')
  const [followText, setFollowText] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<unknown>(null)

  const [grade, setGrade] = useState<ExamGradeResult | null>(null)
  const [retaking, setRetaking] = useState(false)
  const [retakeError, setRetakeError] = useState<unknown>(null)

  // ---- 载入 ----
  useEffect(() => {
    let alive = true
    setLoading(true)
    setLoadError(null)
    setStage('objective')
    setExam(null)
    setQuestions([])
    setDay(null)
    setAnswers({})
    setActiveId(null)
    setObjectiveResult(null)
    setObjectiveError(null)
    setView(null)
    setViewError(null)
    setViewLoading(false)
    setExplainText('')
    setFollowText('')
    setSendError(null)
    setGrade(null)
    setRetakeError(null)

    const run = async (): Promise<void> => {
      if (!currentExamId) {
        setLoadError(new Error('缺少检测编号'))
        setLoading(false)
        return
      }
      try {
        const payload = await call<ExamPayload>(IPC.EXAM_GET, { examId: currentExamId })
        if (!alive) return
        setExam(payload.exam)
        setQuestions(payload.questions)
        // 标题与返回目标用的 Day 信息，失败不影响主流程
        void call<DayDetail>(IPC.DAY_GET, { dayId: payload.exam.dayId })
          .then((detail) => {
            if (alive) setDay(detail)
          })
          .catch(() => undefined)

        if (payload.exam.status === 'graded') {
          // 历史结果：补一次复述视图（可能失败，失败就只显示总分）
          try {
            const recitation = await call<RecitationView>(IPC.RECITATION_START, { examId: currentExamId })
            if (alive) setView(recitation)
          } catch {
            /* 没有复述明细也能看总分 */
          }
          if (alive) setStage('result')
        } else if (payload.exam.status === 'objective_done') {
          setStage('recitation')
          try {
            const recitation = await call<RecitationView>(IPC.RECITATION_START, { examId: currentExamId })
            if (alive) setView(recitation)
          } catch (error) {
            if (alive) setViewError(error)
          }
        }
      } catch (error) {
        if (alive) setLoadError(error)
      } finally {
        if (alive) setLoading(false)
      }
    }

    void run()
    return () => {
      alive = false
    }
  }, [currentExamId, reloadKey])

  // ---- 客观题键盘：1–4 选项 ----
  useEffect(() => {
    if (stage !== 'objective' || objectiveResult !== null) return
    const handler = (event: globalThis.KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return
      }
      const digit = Number(event.key)
      if (!Number.isInteger(digit) || digit < 1 || digit > 9) return
      const choice = digit - 1
      const choiceQuestions = questions.filter((question) => question.type === 'single_choice')
      const focused = activeId ? questions.find((question) => question.id === activeId) : undefined
      const pending = focused && focused.type === 'single_choice' && !answers[focused.id] ? focused : undefined
      const targetQuestion = pending ?? choiceQuestions.find((question) => !answers[question.id])
      if (!targetQuestion) return
      const options = targetQuestion.options ?? []
      if (options[choice] === undefined) return
      event.preventDefault()
      setAnswers((prev) => ({ ...prev, [targetQuestion.id]: String(choice) }))
      setActiveId(targetQuestion.id)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [stage, objectiveResult, questions, activeId, answers])

  const answeredCount = questions.filter((question) => (answers[question.id] ?? '').trim() !== '').length
  const allAnswered = questions.length > 0 && answeredCount === questions.length
  const explainBody = explainText.trim()
  const explainCount = charCount(explainBody)
  const explainEnough = explainCount >= SCORING.minExplainChars
  const followBody = followText.trim()
  const followCount = charCount(followBody)
  const followEnough = followCount >= SCORING.minFollowupChars
  const backTarget = exam ? `/day/${exam.dayId}` : '/'

  const loadRecitation = async (): Promise<void> => {
    if (!currentExamId) return
    setViewLoading(true)
    setViewError(null)
    try {
      setView(await call<RecitationView>(IPC.RECITATION_START, { examId: currentExamId }))
    } catch (error) {
      setViewError(error)
    } finally {
      setViewLoading(false)
    }
  }

  const enterRecitation = async (): Promise<void> => {
    setStage('recitation')
    setSendError(null)
    if (view === null) await loadRecitation()
  }

  const submitObjective = async (): Promise<void> => {
    if (!exam || submitting || !allAnswered) return
    setSubmitting(true)
    setObjectiveError(null)
    const payload: Record<string, string> = {}
    questions.forEach((question) => {
      payload[question.id] = (answers[question.id] ?? '').trim()
    })
    try {
      const result = await call<ExamObjectiveResult>(IPC.EXAM_SUBMIT_OBJECTIVE, {
        examId: exam.id,
        answers: payload
      })
      setObjectiveResult(result)
      setExam(result.exam)
    } catch (error) {
      setObjectiveError(error)
    } finally {
      setSubmitting(false)
    }
  }

  /** 阶段 A：提交讲解（后端让 AI 追问） */
  const submitExplain = async (): Promise<void> => {
    if (!view || sending || !explainEnough) return
    setSending(true)
    setSendError(null)
    try {
      const next = await call<RecitationView>(IPC.RECITATION_SAY, {
        recitationId: view.id,
        text: explainBody
      })
      setView(next)
      if (next.status === 'graded') setStage('result')
    } catch (error) {
      setSendError(error)
    } finally {
      setSending(false)
    }
  }

  /** 阶段 B：回答追问并直接结算（recitation:submit 需要 text） */
  const submitFollowup = async (): Promise<void> => {
    if (!view || sending || !followEnough) return
    setSending(true)
    setSendError(null)
    try {
      const result = await call<ExamGradeResult>(IPC.RECITATION_SUBMIT, {
        recitationId: view.id,
        text: followBody
      })
      setGrade(result)
      setExam(result.exam)
      setView(result.recitation)
      setStage('result')
    } catch (error) {
      setSendError(error)
    } finally {
      setSending(false)
    }
  }

  const retake = async (): Promise<void> => {
    if (!exam || retaking) return
    setRetaking(true)
    setRetakeError(null)
    try {
      const payload = await call<ExamPayload>(IPC.EXAM_CREATE, { dayId: exam.dayId })
      navigate(`/exam/${payload.exam.id}`)
    } catch (error) {
      setRetakeError(error)
    } finally {
      setRetaking(false)
    }
  }

  const onFormKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    const target = event.target as HTMLElement
    const tag = target.tagName
    // 选项按钮上的 Enter 交还给按钮自己；输入框里的 Enter 直接提交
    if (tag === 'BUTTON' || tag === 'TEXTAREA') return
    if (!allAnswered || submitting) return
    event.preventDefault()
    void submitObjective()
  }

  const stepIndex = STEPS.findIndex((step) => step.key === stage)

  // ---- 异常 / 加载 ----
  if (loading) {
    return (
      <Page title="Day 检测" subtitle="正在读取这次检测…">
        <Card>
          <div className="exam-loading">
            <Spinner size={16} />
            <span>正在读取题目…</span>
          </div>
          <Skeleton lines={4} height={16} />
        </Card>
      </Page>
    )
  }

  if (loadError) {
    return (
      <Page title="Day 检测">
        <Card>
          <ErrorState error={loadError} onRetry={() => setReloadKey((value) => value + 1)} retryText="重新加载" />
          <div className="exam-inline-actions">
            <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
              回到学习看板
            </Button>
          </div>
        </Card>
      </Page>
    )
  }

  // ---- 结果 ----
  const renderResult = (): JSX.Element => {
    const resultView = grade?.recitation ?? (view?.status === 'graded' ? view : null)
    const totalScore = grade?.totalScore ?? exam?.totalScore ?? 0
    const level = levelOf(totalScore)
    const objectiveScore = grade?.exam.objectiveScore ?? exam?.objectiveScore ?? null
    const recitationScore = resultView?.score ?? exam?.recitationScore ?? null
    const perQuestion =
      grade?.objective ??
      objectiveResult?.perQuestion ??
      questions
        .filter((question) => question.correct !== null && question.correct !== undefined)
        .map((question) => ({
          questionId: question.id,
          correct: question.correct === true,
          userAnswer: question.userAnswer ?? '',
          answer: question.answer,
          explanation: question.explanation
        }))
    const dimensions = resultView?.dimensions ?? null
    const advice = grade?.advice ?? null
    const correctCount = perQuestion.filter((item) => item.correct).length

    return (
      <>
        <Card className="exam-result" flush>
          <div className="exam-result__inner">
            <div className="exam-result__main">
              <p className="exam-result__eyebrow">本次检测</p>
              <p className="exam-result__score">
                <span className="exam-result__num">{Math.round(totalScore)}</span>
                <span className="exam-result__total">/ 100</span>
              </p>
              <p className="exam-result__split">
                客观 {objectiveScore ?? '—'} / {SCORING.objectiveTotal} · 复述 {recitationScore ?? '—'} /{' '}
                {SCORING.recitationTotal}
              </p>
            </div>
            <div className="exam-result__side">
              <Badge tone={level.tone} dot size="md">
                {level.label}
              </Badge>
              <p className="exam-result__hint">
                {level.label === '通过'
                  ? `${SCORING.passLine} 分及以上算通过，这一天已经解锁。`
                  : level.label === '部分通过'
                    ? `${SCORING.partialLine}–${SCORING.passLine - 1} 分算部分通过，可以重考刷新成绩。`
                    : `低于 ${SCORING.partialLine} 分，建议回看这一天的任务，再考一次。`}
              </p>
            </div>
          </div>
        </Card>

        {perQuestion.length > 0 ? (
          <Card title="客观题回顾" subtitle={`${correctCount} / ${perQuestion.length} 题答对`} flush>
            <ul className="exam-review">
              {perQuestion.map((row, index) => {
                const question = questions.find((item) => item.id === row.questionId)
                return (
                  <li className="exam-review__row" key={row.questionId}>
                    <div className="exam-review__head">
                      <Badge tone={row.correct ? 'success' : 'danger'} size="sm">
                        {row.correct ? '对' : '错'}
                      </Badge>
                      <span className="exam-review__stem">
                        {question ? `${index + 1}. ${question.stem}` : `第 ${index + 1} 题`}
                      </span>
                    </div>
                    <p className="exam-review__line">你的答案：{answerText(question, row.userAnswer)}</p>
                    {row.correct ? null : (
                      <p className="exam-review__line exam-review__line--answer">
                        正确答案：{answerText(question, row.answer)}
                      </p>
                    )}
                    {row.explanation ? <p className="exam-review__explain">{row.explanation}</p> : null}
                  </li>
                )
              })}
            </ul>
          </Card>
        ) : questions.length > 0 ? (
          <Card title="客观题回顾" subtitle="历史记录只保留正确答案" flush>
            <ul className="exam-review">
              {questions.map((question, index) => (
                <li className="exam-review__row" key={question.id}>
                  <div className="exam-review__head">
                    <span className="exam-review__stem">
                      {index + 1}. {question.stem}
                    </span>
                  </div>
                  <p className="exam-review__line exam-review__line--answer">
                    正确答案：{answerText(question, question.answer)}
                  </p>
                  {question.explanation ? (
                    <p className="exam-review__explain">{question.explanation}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {dimensions ? (
          <Card
            title="费曼复述"
            subtitle={`复述得分 ${recitationScore ?? '—'} / ${SCORING.recitationTotal}`}
          >
            <ul className="exam-dims">
              {DIMENSIONS.map((item) => {
                const value = clamp01(dimensions[item.key])
                const percent = Math.round(value * 100)
                const tone: Tone = value >= 0.8 ? 'success' : value >= 0.5 ? 'warn' : 'danger'
                return (
                  <li className="exam-dim" key={item.key}>
                    <span className="exam-dim__label">
                      {item.label}
                      <span className="exam-dim__weight">{item.weight} 分</span>
                    </span>
                    <span className="exam-dim__meter">
                      <i className={`exam-dim__fill exam-dim__fill--${tone}`} style={{ width: `${percent}%` }} />
                    </span>
                    <span className="exam-dim__value">{percent}%</span>
                    <span className="exam-dim__hint">{item.hint}</span>
                  </li>
                )
              })}
            </ul>
            {resultView?.feedback || resultView?.criticalGap ? (
              <div className="exam-feedback">
                {resultView?.feedback ? (
                  <div className="exam-feedback__block">
                    <p className="exam-feedback__label">AI 点评</p>
                    <p className="exam-feedback__text">{resultView.feedback}</p>
                  </div>
                ) : null}
                {resultView?.criticalGap ? (
                  <div className="exam-feedback__block exam-feedback__block--warn">
                    <p className="exam-feedback__label">最大的漏洞</p>
                    <p className="exam-feedback__text">{resultView.criticalGap}</p>
                  </div>
                ) : null}
              </div>
            ) : null}
          </Card>
        ) : (
          <Card title="费曼复述" subtitle="这次没有留下复述明细">
            <p className="exam-hint">
              复述得分 {recitationScore ?? '—'} / {SCORING.recitationTotal}。重新做一次检测，可以拿到四维度的点评。
            </p>
          </Card>
        )}

        {advice ? (
          <Card title="下一步建议" tone="accent">
            <p className="exam-advice">{advice}</p>
          </Card>
        ) : null}

        {retakeError ? <ErrorState error={retakeError} compact onRetry={() => void retake()} /> : null}

        <div className="exam-actions">
          <Button onClick={() => navigate('/')}>回到看板</Button>
          <Button variant="ghost" onClick={() => navigate(backTarget)}>
            回到这一天
          </Button>
          <Button variant="subtle" onClick={() => void retake()} loading={retaking}>
            {retaking ? '正在出题…' : '再考一次'}
          </Button>
        </div>
        {retaking ? <p className="exam-hint">重新出题通常要 10–30 秒，别关窗口。</p> : null}
      </>
    )
  }

  // ---- 费曼复述 ----
  const renderRecitation = (): JSX.Element => {
    if (viewError) {
      return (
        <Card>
          <ErrorState error={viewError} onRetry={() => void loadRecitation()} />
          <div className="exam-inline-actions">
            <Button variant="ghost" size="sm" onClick={() => navigate(backTarget)}>
              回到今日学习
            </Button>
          </div>
        </Card>
      )
    }

    if (view === null) {
      return (
        <Card>
          <div className="exam-loading">
            <Spinner size={16} />
            <span>正在准备复述场景…</span>
          </div>
          <Skeleton lines={4} height={16} />
        </Card>
      )
    }

    if (view.status === 'grading') {
      return (
        <Card className="exam-grading">
          <div className="exam-loading">
            <Spinner size={18} />
            <span>AI 正在按四个维度评分…</span>
          </div>
          <p className="exam-hint">通常 10–20 秒。评分完成后会自动结算这次检测。</p>
          <div className="exam-inline-actions">
            <Button variant="ghost" size="sm" onClick={() => void loadRecitation()} loading={viewLoading}>
              刷新状态
            </Button>
          </div>
        </Card>
      )
    }

    if (view.status === 'graded') {
      return (
        <Card title="复述已评分">
          <p className="exam-hint">
            复述得分 {view.score ?? '—'} / {SCORING.recitationTotal}。
          </p>
          <div className="exam-inline-actions">
            <Button onClick={() => setStage('result')}>查看结果</Button>
          </div>
        </Card>
      )
    }

    const chatDone = view.messages.some((message) => message.role === 'student') || view.followUp !== null
    const explaining = view.status === 'awaiting_explain' && !chatDone

    if (explaining) {
      return (
        <>
          <Card className="exam-recite" flush>
            <div className="exam-recite__inner">
              <div className="exam-prompt">
                <span className="exam-prompt__avatar">学生</span>
                <p className="exam-prompt__text">{view.prompt}</p>
              </div>
              <p className="exam-note">讲解时不要看书。想到哪说到哪，但要让对方听懂。</p>
              <div className="exam-compose">
                <TextArea
                  rows={11}
                  value={explainText}
                  disabled={sending}
                  autoFocus
                  placeholder="先说结论，再解释为什么，最后举一个自己的例子。"
                  onChange={(event) => setExplainText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault()
                      if (explainEnough && !sending) void submitExplain()
                    }
                  }}
                  aria-label="讲解内容"
                />
                <div className="exam-counter">
                  <span className={`exam-counter__count ${explainEnough ? 'is-ok' : ''}`}>
                    {explainCount} 字 / 最少 {SCORING.minExplainChars} 字
                  </span>
                  <KeyHint keys="Ctrl+Enter">提交</KeyHint>
                </div>
              </div>
              {sendError ? <ErrorState error={sendError} compact /> : null}
            </div>
          </Card>
          <footer className="exam-bar">
            <div className="exam-bar__info">
              <span>阶段 A · 讲解</span>
              <span className="exam-bar__hint">
                {explainEnough ? '讲完了就提交，AI 学生会追问一个问题。' : `还差 ${SCORING.minExplainChars - explainCount} 字。`}
              </span>
            </div>
            <div className="exam-bar__actions">
              <Button onClick={() => void submitExplain()} loading={sending} disabled={!explainEnough}>
                提交讲解
              </Button>
            </div>
          </footer>
        </>
      )
    }

    // 阶段 B：AI 已追问，等用户补充
    return (
      <>
        <Card className="exam-recite" flush>
          <div className="exam-recite__inner">
            <div className="exam-chat">
              {view.messages.map((message, index) => (
                <div
                  className={`exam-bubble exam-bubble--${message.role}`}
                  key={`${index}-${message.at}`}
                >
                  <span className="exam-bubble__avatar">{message.role === 'user' ? '你' : '学生'}</span>
                  <div className="exam-bubble__body">
                    <p className="exam-bubble__text">{message.text}</p>
                  </div>
                </div>
              ))}
              {view.followUp && !view.messages.some((message) => message.role === 'student') ? (
                <div className="exam-bubble exam-bubble--student">
                  <span className="exam-bubble__avatar">学生</span>
                  <div className="exam-bubble__body">
                    <p className="exam-bubble__text">{view.followUp}</p>
                  </div>
                </div>
              ) : null}
            </div>
            <p className="exam-note">学生只问了这一个点。别翻书，把没讲清的地方补上。</p>
            <div className="exam-compose">
              <TextArea
                rows={6}
                value={followText}
                disabled={sending}
                autoFocus
                placeholder="补充说明这个概念，或者讲一个更具体的例子。"
                onChange={(event) => setFollowText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault()
                    if (followEnough && !sending) void submitFollowup()
                  }
                }}
                aria-label="追问回答"
              />
              <div className="exam-counter">
                <span className={`exam-counter__count ${followEnough ? 'is-ok' : ''}`}>
                  {followCount} 字 / 最少 {SCORING.minFollowupChars} 字
                </span>
                <KeyHint keys="Ctrl+Enter">提交评分</KeyHint>
              </div>
            </div>
            {sendError ? <ErrorState error={sendError} compact /> : null}
          </div>
        </Card>
        <footer className="exam-bar">
          <div className="exam-bar__info">
            <span>阶段 B · 回答追问</span>
            <span className="exam-bar__hint">
              {followEnough ? '提交后会按准确性、完整性、举例、清晰度打分。' : `还差 ${SCORING.minFollowupChars - followCount} 字。`}
            </span>
          </div>
          <div className="exam-bar__actions">
            <Button onClick={() => void submitFollowup()} loading={sending} disabled={!followEnough}>
              提交评分
            </Button>
          </div>
        </footer>
      </>
    )
  }

  // ---- 客观题 ----
  const renderObjective = (): JSX.Element => {
    const submittedElsewhere = exam?.status === 'objective_done' && objectiveResult === null
    if (submittedElsewhere) {
      return (
        <>
          <Card title="客观题已提交" subtitle={`客观题得分 ${exam?.objectiveScore ?? '—'} / ${SCORING.objectiveTotal}`}>
            <p className="exam-hint">这次检测的客观题已经交过了，接着把费曼复述做完就会结算。</p>
            <div className="exam-inline-actions">
              <Button onClick={() => void enterRecitation()}>进入费曼复述</Button>
            </div>
          </Card>
        </>
      )
    }

    if (questions.length === 0) {
      return (
        <Card>
          <EmptyState
            title="这次检测没有题目"
            description="题目可能没生成成功，回到这一天再发起一次检测。"
            action={<Button onClick={() => navigate(backTarget)}>回到这一天</Button>}
          />
        </Card>
      )
    }

    return (
      <>
        <div className="exam-intro">
          <span className="exam-intro__tag">客观题</span>
          <p className="exam-intro__text">
            共 {questions.length} 题，每题 {SCORING.objectivePerQuestion} 分。按 <KeyHint keys="1-4" /> 选选项，答完再提交。
          </p>
        </div>
        <div className="exam-form" onKeyDown={onFormKeyDown}>
          {questions.map((question, index) => {
            const value = answers[question.id] ?? ''
            const graded = objectiveResult?.perQuestion.find((item) => item.questionId === question.id) ?? null
            const answerIndex = graded ? correctIndex(question, graded.answer) : -1
            return (
              <Card
                key={question.id}
                className="exam-q"
                title={
                  <span className="exam-q__head">
                    <span className="exam-q__index">第 {index + 1} 题</span>
                    <span className="exam-q__type">{question.type === 'single_choice' ? '单选' : '填空'}</span>
                  </span>
                }
                subtitle={question.knowledgePoint ? `考点：${question.knowledgePoint}` : undefined}
                actions={<span className="exam-q__point">{question.point} 分</span>}
              >
                <p className="exam-q__stem">{question.stem}</p>
                {question.type === 'single_choice' && question.options ? (
                  <ul className="exam-opts">
                    {question.options.map((option, optionIndex) => {
                      const picked = value === String(optionIndex)
                      const isAnswer = graded ? optionIndex === answerIndex : false
                      const isWrong = graded ? picked && !graded.correct : false
                      return (
                        <li key={optionIndex}>
                          <button
                            type="button"
                            className={[
                              'exam-opt',
                              picked ? 'is-picked' : '',
                              isAnswer ? 'is-correct' : '',
                              isWrong ? 'is-wrong' : ''
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            disabled={graded !== null}
                            aria-pressed={picked}
                            onClick={() => {
                              setAnswers((prev) => ({ ...prev, [question.id]: String(optionIndex) }))
                              setActiveId(question.id)
                            }}
                          >
                            <span className="exam-opt__key">{optionIndex + 1}</span>
                            <span className="exam-opt__text">{option}</span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <Input
                    value={value}
                    disabled={graded !== null}
                    aria-label={`第 ${index + 1} 题答案`}
                    placeholder="填写答案，同义词也算对"
                    onChange={(event) => setAnswers((prev) => ({ ...prev, [question.id]: event.target.value }))}
                    onFocus={() => setActiveId(question.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && allAnswered && !submitting && !graded) {
                        event.preventDefault()
                        void submitObjective()
                      }
                    }}
                  />
                )}
                {graded ? (
                  <div className={`exam-q__result ${graded.correct ? 'is-ok' : 'is-bad'}`}>
                    <p className="exam-q__verdict">
                      <Badge tone={graded.correct ? 'success' : 'danger'} size="sm">
                        {graded.correct ? '答对' : '答错'}
                      </Badge>
                      <span>你的答案：{answerText(question, graded.userAnswer)}</span>
                      {graded.correct ? null : (
                        <span>正确答案：{answerText(question, graded.answer)}</span>
                      )}
                    </p>
                    {graded.explanation ? <p className="exam-q__explain">{graded.explanation}</p> : null}
                  </div>
                ) : null}
              </Card>
            )
          })}
        </div>

        {objectiveError ? <ErrorState error={objectiveError} onRetry={() => void submitObjective()} /> : null}

        <footer className="exam-bar">
          <div className="exam-bar__info">
            <span>
              已作答 {answeredCount} / {questions.length}
            </span>
            <span className="exam-bar__hint">
              {objectiveResult
                ? `客观题得分 ${objectiveResult.objectiveScore} / ${SCORING.objectiveTotal}`
                : '客观题占 50 分，提交后不能改答案。'}
            </span>
          </div>
          <div className="exam-bar__actions">
            {objectiveResult ? (
              <Button onClick={() => void enterRecitation()}>进入费曼复述</Button>
            ) : (
              <Button
                onClick={() => void submitObjective()}
                loading={submitting}
                disabled={!allAnswered}
              >
                提交客观题
              </Button>
            )}
          </div>
        </footer>
      </>
    )
  }

  return (
    <Page
      title="Day 检测"
      subtitle={day ? `Day ${day.index} · ${day.title}` : '客观题 + 费曼复述，约 5–8 分钟'}
      actions={
        <Button variant="ghost" size="sm" onClick={() => navigate(backTarget)}>
          返回今日学习
        </Button>
      }
    >
      <ol className="exam-steps" aria-label="检测流程">
        {STEPS.map((step, index) => {
          const done = index < stepIndex || (index === 0 && objectiveResult !== null && stage === 'objective')
          const active = index === stepIndex && !done
          return (
            <li
              className={['exam-step', done ? 'is-done' : '', active ? 'is-active' : '']
                .filter(Boolean)
                .join(' ')}
              key={step.key}
            >
              <span className="exam-step__num" aria-hidden="true">
                {done ? '✓' : index + 1}
              </span>
              <span className="exam-step__label">{step.label}</span>
            </li>
          )
        })}
      </ol>

      {stage === 'objective' ? renderObjective() : null}
      {stage === 'recitation' ? renderRecitation() : null}
      {stage === 'result' ? renderResult() : null}
    </Page>
  )
}
