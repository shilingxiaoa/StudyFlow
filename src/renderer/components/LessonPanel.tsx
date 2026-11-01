/* ============================================================
   StudyFlow · AI 每日教案
   今天的教学目标 → 分节讲解 / 动手练一练 / 任务步骤 / 自检 / 答疑
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX, KeyboardEvent } from 'react'
import { IPC } from '@shared/contracts'
import type { Lesson, LessonAskResult, LessonPractice, PracticeKind } from '@shared/contracts'
import { Badge, Button, Card, ErrorState, Modal, Skeleton, Spinner, TextArea, useToast } from './ui'
import { Markdown } from './markdown'
import { call, errorMessage } from '../lib/api'
import { formatDateTime } from '../lib/format'
import type { Tone } from '../lib/format'
import './LessonPanel.css'

export interface LessonPanelProps {
  /** 换一天就重新取一次教案 */
  dayId: string
  /** 读完这一课后的去处：切到「任务清单」继续勾任务 */
  onGoTasks?: () => void
}

/** 生成过程里的阶段文案，按固定节奏轮播，让 20–40 秒不至于像卡住 */
const GEN_STAGES = [
  '正在梳理这一天的知识点…',
  '正在对照你的资料写讲解…',
  '正在设计练习和自检清单…'
] as const

const STAGE_INTERVAL = 5000
const POLL_INTERVAL = 3000
const POLL_MAX = 60

const PRACTICE_LABEL: Record<PracticeKind, string> = {
  exercise: '练习',
  recall: '回想',
  apply: '应用'
}

const PRACTICE_TONE: Record<PracticeKind, Tone> = {
  exercise: 'accent',
  recall: 'info',
  apply: 'warn'
}

interface AskMessage {
  id: number
  role: 'user' | 'ai'
  text: string
}

/** 练习题：提示与答案默认收起，按需展开 */
function PracticeItem({ practice, index }: { practice: LessonPractice; index: number }): JSX.Element {
  const [hintOpen, setHintOpen] = useState(false)
  const [answerOpen, setAnswerOpen] = useState(false)
  const hasHint = practice.hint.trim() !== ''
  const hasAnswer = practice.answer.trim() !== ''

  return (
    <li className="sf-lesson__practice">
      <div className="sf-lesson__practice-head">
        <Badge tone={PRACTICE_TONE[practice.kind]} size="sm">
          {PRACTICE_LABEL[practice.kind]}
        </Badge>
        <span className="sf-lesson__practice-index">第 {index + 1} 题</span>
      </div>
      <div className="sf-lesson__practice-prompt">
        <Markdown text={practice.prompt} />
      </div>
      {hasHint ? (
        <div className="sf-lesson__practice-tools">
          <Button
            variant="subtle"
            size="sm"
            aria-expanded={hintOpen}
            onClick={() => setHintOpen((value) => !value)}
          >
            {hintOpen ? '收起提示' : '提示'}
          </Button>
          {hasAnswer ? (
            <Button
              variant="subtle"
              size="sm"
              aria-expanded={answerOpen}
              onClick={() => setAnswerOpen((value) => !value)}
            >
              {answerOpen ? '收起答案' : '看答案'}
            </Button>
          ) : null}
        </div>
      ) : hasAnswer ? (
        <div className="sf-lesson__practice-tools">
          <Button
            variant="subtle"
            size="sm"
            aria-expanded={answerOpen}
            onClick={() => setAnswerOpen((value) => !value)}
          >
            {answerOpen ? '收起答案' : '看答案'}
          </Button>
        </div>
      ) : null}
      {hintOpen && hasHint ? (
        <div className="sf-lesson__practice-hint">
          <span className="sf-lesson__practice-tag">提示</span>
          <Markdown text={practice.hint} />
        </div>
      ) : null}
      {answerOpen && hasAnswer ? (
        <div className="sf-lesson__practice-answer">
          <span className="sf-lesson__practice-tag">答案</span>
          <Markdown text={practice.answer} />
        </div>
      ) : null}
    </li>
  )
}

/**
 * 每日教案面板：自己取数、自己生成、自己答疑。
 * 答疑消息只存在当前会话里，刷新即清空。
 */
export function LessonPanel({ dayId, onGoTasks }: LessonPanelProps): JSX.Element {
  const toast = useToast()

  const [lesson, setLesson] = useState<Lesson | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [stageIndex, setStageIndex] = useState(0)
  const [pollExpired, setPollExpired] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [checked, setChecked] = useState<number[]>([])
  const [messages, setMessages] = useState<AskMessage[]>([])
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)

  const dayIdRef = useRef(dayId)
  dayIdRef.current = dayId
  const seqRef = useRef(0)
  const messageIdRef = useRef(0)
  const chatRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const seq = seqRef.current + 1
    seqRef.current = seq
    setLoading(true)
    setLoadError(null)
    try {
      const next = await call<Lesson>(IPC.LESSON_GET, { dayId })
      if (seq !== seqRef.current) return
      setLesson(next)
    } catch (error) {
      if (seq !== seqRef.current) return
      setLoadError(errorMessage(error))
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [dayId])

  // 换一天：清掉上一天的本地状态（自检勾选、答疑消息）再取新教案
  useEffect(() => {
    seqRef.current += 1
    setLesson(null)
    setLoading(true)
    setLoadError(null)
    setGenerating(false)
    setGenerateError(null)
    setConfirmOpen(false)
    setChecked([])
    setMessages([])
    setQuestion('')
    setAsking(false)
    setPollExpired(false)
    setStageIndex(0)
    void load()
  }, [dayId, load])

  const busy = generating || lesson?.status === 'generating'

  // 阶段文案轮播
  useEffect(() => {
    if (!busy) {
      setStageIndex(0)
      return undefined
    }
    const timer = window.setInterval(() => {
      setStageIndex((value) => (value + 1) % GEN_STAGES.length)
    }, STAGE_INTERVAL)
    return () => window.clearInterval(timer)
  }, [busy])

  // 远端还在生成（比如中途重开页面）时轮询，直到拿到结果或超时
  useEffect(() => {
    if (generating || lesson?.status !== 'generating') return undefined
    let cancelled = false
    let tries = 0
    setPollExpired(false)
    const timer = window.setInterval(() => {
      if (cancelled) return
      if (tries >= POLL_MAX) {
        setPollExpired(true)
        window.clearInterval(timer)
        return
      }
      tries += 1
      void call<Lesson>(IPC.LESSON_GET, { dayId })
        .then((next) => {
          if (!cancelled) setLesson(next)
        })
        .catch(() => {
          // 轮询失败不打扰用户，下一轮再试
        })
    }, POLL_INTERVAL)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [dayId, generating, lesson?.status])

  // 教案更新后，自检勾选从头开始（只在本地，不写库）
  const lessonStamp = lesson ? `${lesson.dayId}|${lesson.updatedAt ?? ''}` : ''
  useEffect(() => {
    setChecked([])
  }, [lessonStamp])

  const runGenerate = useCallback(
    async (force: boolean): Promise<void> => {
      if (generating) return
      setConfirmOpen(false)
      setGenerating(true)
      setGenerateError(null)
      setStageIndex(0)
      try {
        const next = await call<Lesson>(
          IPC.LESSON_GENERATE,
          force ? { dayId, force: true } : { dayId }
        )
        if (dayIdRef.current !== dayId) return
        setLesson(next)
        if (next.status === 'ready') toast.success('教案已生成')
      } catch (error) {
        if (dayIdRef.current !== dayId) return
        const message = errorMessage(error)
        setGenerateError(message)
        toast.danger(message)
      } finally {
        if (dayIdRef.current === dayId) setGenerating(false)
      }
    },
    [dayId, generating, toast]
  )

  const toggleCheck = (index: number): void => {
    setChecked((list) =>
      list.includes(index) ? list.filter((item) => item !== index) : [...list, index]
    )
  }

  // 新消息进来时把聊天区滚到底部
  useEffect(() => {
    const node = chatRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages, asking])

  const ask = useCallback(async (): Promise<void> => {
    const text = question.trim()
    if (text === '' || asking) return
    setAsking(true)
    setQuestion('')
    setMessages((list) => [...list, { id: ++messageIdRef.current, role: 'user', text }])
    try {
      const result = await call<LessonAskResult>(IPC.LESSON_ASK, { dayId, question: text })
      if (dayIdRef.current !== dayId) return
      if (result.answer.trim() === '') {
        toast.warn('这次没有拿到回答，换个问法再试试。')
        return
      }
      setMessages((list) => [
        ...list,
        { id: ++messageIdRef.current, role: 'ai', text: result.answer }
      ])
    } catch (error) {
      if (dayIdRef.current !== dayId) return
      toast.danger(errorMessage(error))
    } finally {
      if (dayIdRef.current === dayId) setAsking(false)
    }
  }, [asking, dayId, question, toast])

  const onAskKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void ask()
    }
  }

  // ---- 首屏读取 ----
  if (loading && !lesson) {
    return (
      <div className="sf-lesson">
        <Card className="sf-lesson__loading">
          <div className="sf-lesson__loading-body">
            <div className="sf-lesson__loading-row">
              <Skeleton width={220} height={20} />
              <Skeleton width={96} height={14} />
            </div>
            <Skeleton lines={3} height={13} />
          </div>
        </Card>
        <Card className="sf-lesson__loading">
          <Skeleton lines={2} height={18} />
        </Card>
      </div>
    )
  }

  if (loadError && !lesson) {
    return (
      <div className="sf-lesson">
        <Card>
          <ErrorState message={loadError} onRetry={() => void load()} />
        </Card>
      </div>
    )
  }

  if (!lesson) {
    return (
      <div className="sf-lesson">
        <Card>
          <ErrorState message="还没有读到这一天的教案。" onRetry={() => void load()} />
        </Card>
      </div>
    )
  }

  // ---- 教案就绪 ----
  if (lesson.status === 'ready') {
    const totalMinutes = lesson.sections.reduce(
      (sum, section) => sum + (Number.isFinite(section.minutes) ? section.minutes : 0),
      0
    )
    const totalChecks = lesson.selfCheck.length
    const doneChecks = checked.filter((index) => index < totalChecks).length

    return (
      <div className="sf-lesson">
        {generating ? (
          <div className="sf-lesson__busy" role="status">
            <Spinner size={14} />
            <span>{GEN_STAGES[stageIndex]}</span>
          </div>
        ) : null}

        {generateError && !generating ? (
          <ErrorState
            compact
            message={`重新备课没有成功：${generateError}`}
            onRetry={() => void runGenerate(true)}
            retryText="再试一次"
          />
        ) : null}

        <header className="sf-lesson__head">
          <div className="sf-lesson__head-main">
            <h2 className="sf-lesson__title">{lesson.title || '今日教案'}</h2>
            {lesson.overview ? <p className="sf-lesson__overview">{lesson.overview}</p> : null}
          </div>
          <div className="sf-lesson__head-meta">
            {totalMinutes > 0 ? (
              <Badge tone="accent" size="sm">{`约 ${totalMinutes} 分钟`}</Badge>
            ) : null}
            {lesson.updatedAt ? (
              <span className="sf-lesson__updated" title={formatDateTime(lesson.updatedAt)}>
                更新于 {formatDateTime(lesson.updatedAt)}
              </span>
            ) : null}
          </div>
        </header>

        {lesson.sections.length > 0 ? (
          <div className="sf-lesson__sections">
            {lesson.sections.map((section, index) => (
              <Card
                key={`section-${index}`}
                className="sf-lesson__section"
                title={<span className="sf-lesson__section-title">{section.title}</span>}
                actions={
                  section.minutes > 0 ? (
                    <Badge tone="neutral" size="sm">{`约 ${section.minutes} 分钟`}</Badge>
                  ) : undefined
                }
              >
                <Markdown text={section.body} className="sf-lesson__body" />
              </Card>
            ))}
          </div>
        ) : null}

        {lesson.practices.length > 0 ? (
          <section className="sf-lesson__block">
            <div className="sf-lesson__block-head">
              <h3 className="sf-lesson__block-title">动手练一练</h3>
              <span className="sf-lesson__block-hint">{`${lesson.practices.length} 道`}</span>
            </div>
            <ul className="sf-lesson__practices">
              {lesson.practices.map((practice, index) => (
                <PracticeItem key={`practice-${index}`} index={index} practice={practice} />
              ))}
            </ul>
          </section>
        ) : null}

        {lesson.guides.length > 0 ? (
          <section className="sf-lesson__block">
            <div className="sf-lesson__block-head">
              <h3 className="sf-lesson__block-title">这些任务具体怎么做</h3>
            </div>
            <div className="sf-lesson__guides">
              {lesson.guides.map((guide, index) => (
                <Card key={`guide-${index}`} className="sf-lesson__guide">
                  <h4 className="sf-lesson__guide-title">{guide.taskTitle}</h4>
                  <ol className="sf-lesson__guide-steps">
                    {guide.steps.map((step, stepIndex) => (
                      <li key={`step-${stepIndex}`} className="sf-lesson__guide-step">
                        <span className="sf-lesson__guide-num" aria-hidden="true">
                          {stepIndex + 1}
                        </span>
                        <span className="sf-lesson__guide-text">{step}</span>
                      </li>
                    ))}
                  </ol>
                </Card>
              ))}
            </div>
          </section>
        ) : null}

        {lesson.misconceptions.length > 0 ? (
          <section className="sf-lesson__block">
            <div className="sf-lesson__block-head">
              <h3 className="sf-lesson__block-title">容易踩的坑</h3>
            </div>
            <ul className="sf-lesson__pits">
              {lesson.misconceptions.map((item, index) => (
                <li key={`pit-${index}`} className="sf-lesson__pit">
                  <span className="sf-lesson__pit-icon" aria-hidden="true">
                    !
                  </span>
                  <span className="sf-lesson__pit-text">{item}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {lesson.selfCheck.length > 0 ? (
          <section className="sf-lesson__block">
            <div className="sf-lesson__block-head">
              <h3 className="sf-lesson__block-title">学完自检</h3>
              <Badge tone={doneChecks === totalChecks ? 'success' : 'neutral'} size="sm">
                {`${doneChecks} / ${totalChecks}`}
              </Badge>
            </div>
            <ul className="sf-lesson__checks">
              {lesson.selfCheck.map((item, index) => {
                const isChecked = checked.includes(index)
                return (
                  <li
                    key={`check-${index}`}
                    className={isChecked ? 'sf-lesson__check is-checked' : 'sf-lesson__check'}
                  >
                    <label className="sf-lesson__check-label">
                      <input
                        className="sf-lesson__check-box"
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleCheck(index)}
                      />
                      <span className="sf-lesson__check-text">{item}</span>
                    </label>
                  </li>
                )
              })}
            </ul>
          </section>
        ) : null}

        <Card
          className="sf-lesson__ask"
          title="不懂就问"
          subtitle="针对这一天问一句，AI 会对照资料解释，不离开当前页面。"
        >
          <div className="sf-lesson__ask-body">
            {messages.length > 0 || asking ? (
              <div className="sf-lesson__chat" ref={chatRef}>
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`sf-lesson__msg sf-lesson__msg--${message.role}`}
                  >
                    <span className="sf-lesson__msg-role">
                      {message.role === 'user' ? '我' : 'AI'}
                    </span>
                    <div className="sf-lesson__msg-body">
                      {message.role === 'ai' ? (
                        <Markdown text={message.text} />
                      ) : (
                        <p className="sf-lesson__msg-text">{message.text}</p>
                      )}
                    </div>
                  </div>
                ))}
                {asking ? (
                  <div className="sf-lesson__msg sf-lesson__msg--ai">
                    <span className="sf-lesson__msg-role">AI</span>
                    <div className="sf-lesson__msg-body sf-lesson__msg-thinking">
                      <Spinner size={12} />
                      <span>正在想…</span>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            <TextArea
              rows={3}
              placeholder="比如：为什么这里要用 た 形？"
              value={question}
              disabled={asking}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={onAskKeyDown}
              hint="Ctrl + Enter 发送。问答只在当前页面保留，刷新后清空。"
            />
            <div className="sf-lesson__ask-foot">
              <Button
                variant="primary"
                loading={asking}
                disabled={asking || question.trim() === ''}
                onClick={() => void ask()}
              >
                提问
              </Button>
            </div>
          </div>
        </Card>

        <div className="sf-lesson__foot">
          {onGoTasks ? (
            <Button variant="primary" size="sm" onClick={onGoTasks}>
              去任务清单
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            loading={generating}
            disabled={generating}
            onClick={() => setConfirmOpen(true)}
          >
            重新备课
          </Button>
          <span className="sf-lesson__foot-hint">
            {onGoTasks
              ? '看懂之后去任务清单勾完成，勾完就能开始检测。'
              : '会按当前目标和资料重新写一份，之前的内容会被替换。'}
          </span>
        </div>

        <Modal
          open={confirmOpen}
          title="重新备课？"
          width={420}
          onClose={() => setConfirmOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
                取消
              </Button>
              <Button variant="primary" onClick={() => void runGenerate(true)}>
                重新备课
              </Button>
            </>
          }
        >
          <p className="sf-lesson__confirm-text">
            重新备课会再调用一次 AI，按这一天的目标和资料重新写一份教案，大约 20–40 秒。
          </p>
        </Modal>
      </div>
    )
  }

  // ---- 生成失败 ----
  if (lesson.status === 'failed' && !generating) {
    return (
      <div className="sf-lesson">
        <Card className="sf-lesson__failed">
          <ErrorState
            message={lesson.error || '这次备课没有成功，可以再试一次。'}
            onRetry={() => void runGenerate(false)}
            retryText="重试"
          />
        </Card>
      </div>
    )
  }

  // ---- 生成中 ----
  if (generating || lesson.status === 'generating') {
    return (
      <div className="sf-lesson">
        <Card className="sf-lesson__gen" title="正在备课" subtitle="大概 20–40 秒，先别关掉这一页。">
          <div className="sf-lesson__gen-row">
            {generating ? (
              <Button variant="primary" loading disabled>
                正在备课
              </Button>
            ) : (
              <Spinner size={16} />
            )}
            <span className="sf-lesson__gen-stage" role="status">
              {GEN_STAGES[stageIndex]}
            </span>
          </div>
          {!generating && pollExpired ? (
            <div className="sf-lesson__gen-row">
              <span className="sf-lesson__gen-note">
                这次等得有点久，可能是上一次生成被中断了。可以直接重新备课。
              </span>
              <Button variant="ghost" size="sm" loading={loading} onClick={() => void load()}>
                刷新
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={loading}
                onClick={() => void runGenerate(true)}
              >
                重新备课
              </Button>
            </div>
          ) : null}
          {generateError ? <ErrorState compact message={generateError} /> : null}
        </Card>
      </div>
    )
  }

  // ---- 还没备课 ----
  return (
    <div className="sf-lesson">
      <Card
        className="sf-lesson__intro"
        tone="accent"
        title="AI 教案"
        subtitle="把「读教材第 1 节」拆成能照着做的学习计划。"
        actions={
          <Badge tone="accent" size="sm" dot>
            未生成
          </Badge>
        }
      >
        <p className="sf-lesson__intro-text">
          按这一天的目标和资料，AI 会把要学的东西讲清楚：分节讲解 + 练习 + 自检 + 每个任务的具体步骤。
        </p>
        <ul className="sf-lesson__intro-list">
          <li>分节讲解：每一节讲什么、大概花多少分钟</li>
          <li>动手练一练：练习、回想、应用三类题</li>
          <li>任务步骤：把今天每个任务拆成能照做的几步</li>
          <li>学完自检：勾一遍清单，确认自己真的看懂了</li>
        </ul>
        <div className="sf-lesson__intro-foot">
          <Button variant="primary" size="lg" onClick={() => void runGenerate(false)}>
            让 AI 备课（约 20–40 秒）
          </Button>
          <span className="sf-lesson__intro-hint">生成一次会调用 AI，之后可以随时重新备课。</span>
        </div>
        {generateError ? (
          <ErrorState
            compact
            message={generateError}
            onRetry={() => void runGenerate(false)}
            retryText="再试一次"
          />
        ) : null}
      </Card>
    </div>
  )
}

export default LessonPanel
