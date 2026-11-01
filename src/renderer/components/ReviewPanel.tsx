/* ============================================================
   StudyFlow · 复检面板（复盘统计页内的抽题复检）
   ============================================================ */
import { useState } from 'react'
import type { JSX } from 'react'
import type { Question, ReviewPayload, ReviewResult } from '@shared/contracts'
import { Badge, Button, Card, Spinner } from './ui'
import { call, errorMessage } from '../lib/api'
import './ReviewPanel.css'

type Phase = 'idle' | 'drawing' | 'answering' | 'submitting' | 'result'

interface Props {
  goalId: string
  /** 复检结算后回调（父级可刷新统计） */
  onDone?: () => void
}

/**
 * 复检：从已经考过的 Day 里随机抽 2 道旧题。
 * 答错一题就把那一天的 progress 扣 0.2（后端计算），全对只记一条事件。
 */
export default function ReviewPanel({ goalId, onDone }: Props): JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle')
  const [payload, setPayload] = useState<ReviewPayload | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [result, setResult] = useState<ReviewResult | null>(null)
  const [error, setError] = useState<string>('')

  const reset = (): void => {
    setPhase('idle')
    setPayload(null)
    setAnswers({})
    setResult(null)
    setError('')
  }

  const draw = async (): Promise<void> => {
    setPhase('drawing')
    setError('')
    try {
      const next = await call<ReviewPayload>('review:create', { goalId })
      setPayload(next)
      setAnswers({})
      setResult(null)
      setPhase('answering')
    } catch (err) {
      setError(errorMessage(err))
      setPhase('idle')
    }
  }

  const questions: Question[] = payload?.questions ?? []
  const allAnswered = questions.length > 0 && questions.every((item) => (answers[item.id] ?? '').trim() !== '')

  const submit = async (): Promise<void> => {
    if (!payload || !allAnswered) return
    setPhase('submitting')
    setError('')
    try {
      const next = await call<ReviewResult>('review:submit', { goalId, answers })
      setResult(next)
      setPhase('result')
      onDone?.()
    } catch (err) {
      setError(errorMessage(err))
      setPhase('answering')
    }
  }

  const pick = (questionId: string, value: string): void => {
    setAnswers((prev) => ({ ...prev, [questionId]: value }))
  }

  const expanded = phase === 'answering' || phase === 'submitting' || phase === 'result'

  return (
    <Card
      title="复检"
      subtitle="从学过的 Day 里随机抽 2 道旧题，检验是不是真的记住了。"
      actions={
        expanded ? (
          <Button variant="ghost" size="sm" onClick={reset} disabled={phase === 'submitting'}>
            收起
          </Button>
        ) : null
      }
    >
      {phase === 'idle' ? (
        <>
          <p className="sf-review__lead">
            答错一题，那一天的进度会回退 20%；全部答对只记一条复检记录。建议每学完 3–4 个 Day 就回来抽一次。
          </p>
          {error !== '' ? <p className="sf-review__error">{error}</p> : null}
          <div className="sf-review__row">
            <Button onClick={() => void draw()} disabled={goalId === ''}>
              抽 2 题复检
            </Button>
            <span className="sf-faint">题目来自你已经考过的 Day</span>
          </div>
        </>
      ) : null}

      {phase === 'drawing' ? (
        <p className="sf-review__row sf-muted">
          <Spinner size={14} /> 正在挑题…
        </p>
      ) : null}

      {phase === 'answering' || phase === 'submitting' ? (
        <>
          <ol className="sf-review__list">
            {questions.map((question, index) => (
              <li className="sf-review__item" key={question.id}>
                <p className="sf-review__stem">
                  <span className="sf-review__index">{index + 1}</span>
                  <span className="sf-review__stem-text">{question.stem}</span>
                  <Badge tone="neutral" size="sm">
                    {question.type === 'single_choice' ? '单选' : '填空'}
                  </Badge>
                </p>
                {question.type === 'single_choice' ? (
                  <div className="sf-review__options">
                    {(question.options ?? []).map((option, optionIndex) => {
                      const value = String(optionIndex)
                      const active = answers[question.id] === value
                      return (
                        <button
                          type="button"
                          key={value}
                          className={active ? 'sf-review__option is-active' : 'sf-review__option'}
                          onClick={() => pick(question.id, value)}
                          disabled={phase === 'submitting'}
                        >
                          <span className="sf-review__option-key">{String.fromCharCode(65 + optionIndex)}</span>
                          <span>{option}</span>
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <input
                    className="sf-review__input"
                    type="text"
                    value={answers[question.id] ?? ''}
                    placeholder="写出你的答案"
                    disabled={phase === 'submitting'}
                    onChange={(event) => pick(question.id, event.target.value)}
                  />
                )}
              </li>
            ))}
          </ol>
          {error !== '' ? <p className="sf-review__error">{error}</p> : null}
          <div className="sf-review__row">
            <Button loading={phase === 'submitting'} disabled={!allAnswered} onClick={() => void submit()}>
              提交复检
            </Button>
            <span className="sf-faint">{allAnswered ? '提交后立即结算' : '两道题都答完才能提交'}</span>
          </div>
        </>
      ) : null}

      {phase === 'result' && result ? (
        <>
          <div className="sf-review__summary">
            <Badge tone={result.passed ? 'success' : 'danger'} dot size="md">
              {result.passed ? '全部答对' : '有题答错'}
            </Badge>
            <span className="sf-muted">
              当前总进度 {Math.round(result.percent)}%
              {result.delta !== 0 ? (
                <strong className={result.delta > 0 ? 'sf-review__delta is-plus' : 'sf-review__delta is-minus'}>
                  {result.delta > 0 ? ` +${result.delta}` : ` ${result.delta}`}
                </strong>
              ) : null}
            </span>
          </div>
          <ul className="sf-review__result-list">
            {result.perQuestion.map((row, index) => (
              <li className={row.correct ? 'sf-review__result is-ok' : 'sf-review__result is-bad'} key={row.questionId}>
                <div className="sf-review__result-head">
                  <Badge tone={row.correct ? 'success' : 'danger'} size="sm">
                    {row.correct ? '对' : '错'}
                  </Badge>
                  <span className="sf-review__result-stem">第 {index + 1} 题</span>
                </div>
                <p className="sf-review__line">你的答案：{row.userAnswer || '（空）'}</p>
                {row.correct ? null : <p className="sf-review__line">正确答案：{row.answer}</p>}
                {row.explanation ? <p className="sf-review__explain">{row.explanation}</p> : null}
              </li>
            ))}
          </ul>
          <div className="sf-review__row">
            <Button variant="ghost" onClick={() => void draw()}>
              再抽 2 题
            </Button>
            <Button variant="subtle" onClick={reset}>
              完成
            </Button>
          </div>
        </>
      ) : null}
    </Card>
  )
}
