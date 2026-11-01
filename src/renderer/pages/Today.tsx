/* ============================================================
   StudyFlow · 今日学习（#/day/:dayId）
   今日目标 + 检查点 → 任务清单 → 勾完开检测
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, JSX } from 'react'
import { DAY_STATUS_LABEL, IPC } from '@shared/contracts'
import type { DayDetail, ExamPayload, Task, TaskStatus } from '@shared/contracts'
import { Page } from '../components/layout'
import { Badge, Button, Card, EmptyState, ErrorState, Skeleton, Spinner, Tabs } from '../components/ui'
import type { TabItem } from '../components/ui'
import LessonPanel from '../components/LessonPanel'
import { call, errorCode } from '../lib/api'
import { TASK_KIND_LABEL, TASK_STATUS_LABEL, formatMinutes, statusTone } from '../lib/format'
import { navigate, useRoute } from '../lib/router'
import './Today.css'

/** 今日页的两个视图：教案（默认）/ 任务清单 */
type TodayView = 'lesson' | 'tasks'

export interface TodayProps {
  /** 由 App 的 RouteView 传入；缺省时回落到 useRoute().params.dayId */
  dayId?: string
}

function clockText(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export default function Today({ dayId }: TodayProps): JSX.Element {
  const route = useRoute()
  const currentDayId = dayId || route.params.dayId || ''

  const [day, setDay] = useState<DayDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [pendingIds, setPendingIds] = useState<string[]>([])
  const [taskError, setTaskError] = useState<unknown>(null)
  const [creating, setCreating] = useState(false)
  const [examError, setExamError] = useState<unknown>(null)
  const [seconds, setSeconds] = useState(0)
  const [view, setView] = useState<TodayView>('lesson')
  const queueRef = useRef<Promise<void>>(Promise.resolve())

  const load = useCallback(async (): Promise<void> => {
    if (!currentDayId) {
      setDay(null)
      setLoadError(new Error('缺少 Day 编号'))
      setLoading(false)
      return
    }
    try {
      const detail = await call<DayDetail>(IPC.DAY_GET, { dayId: currentDayId })
      setDay(detail)
      setLoadError(null)
    } catch (error) {
      setLoadError(error)
    } finally {
      setLoading(false)
    }
  }, [currentDayId])

  // 换一天就重新取一次，顺带把停留计时归零
  useEffect(() => {
    setLoading(true)
    setDay(null)
    void load()
  }, [load])

  // 本页停留计时：只用于「已学习 mm:ss」，不持久化
  useEffect(() => {
    setSeconds(0)
    const timer = window.setInterval(() => {
      setSeconds((value) => value + 1)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [currentDayId])

  /** 勾选任务：串行排队，逐个用后端返回的 DayDetail 覆盖整页 */
  const changeStatus = (task: Task, status: TaskStatus): void => {
    setPendingIds((list) => (list.includes(task.id) ? list : [...list, task.id]))
    queueRef.current = queueRef.current.then(async () => {
      try {
        const detail = await call<DayDetail>(IPC.TASK_SET_STATUS, { taskId: task.id, status })
        if (detail) setDay(detail)
        setTaskError(null)
      } catch (error) {
        setTaskError(error)
      } finally {
        setPendingIds((list) => list.filter((id) => id !== task.id))
      }
    })
  }

  const startExam = async (): Promise<void> => {
    if (!day || creating) return
    setCreating(true)
    setExamError(null)
    try {
      const payload = await call<ExamPayload>(IPC.EXAM_CREATE, { dayId: day.id })
      navigate(`/exam/${payload.exam.id}`)
    } catch (error) {
      setExamError(error)
    } finally {
      setCreating(false)
    }
  }

  const tasks = day?.tasks ?? []
  const totalCount = tasks.length
  const doneCount = tasks.filter((task) => task.status === 'done').length
  const remaining = Math.max(totalCount - doneCount, 0)
  const allDone = totalCount > 0 && remaining === 0
  const dayStatus = day?.status ?? 'locked'

  const viewTabs: TabItem<TodayView>[] = [
    { key: 'lesson', label: '教案' },
    {
      key: 'tasks',
      label: '任务清单',
      badge: totalCount > 0 ? `${doneCount}/${totalCount}` : undefined
    }
  ]

  // ---- 异常态 ----
  if (loadError && !day) {
    const missing = errorCode(loadError) === 'NOT_FOUND' || !currentDayId
    return (
      <Page title="今日学习">
        {missing ? (
          <EmptyState
            title="这一天不存在"
            description="可能计划已经重新生成，回到看板挑一个正在进行的 Day。"
            action={<Button onClick={() => navigate('/')}>回到学习看板</Button>}
          />
        ) : (
          <Card>
            <ErrorState error={loadError} onRetry={() => void load()} />
            <div className="today-error__back">
              <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
                回到学习看板
              </Button>
            </div>
          </Card>
        )}
      </Page>
    )
  }

  if (loading && !day) {
    return (
      <Page title="今日学习" subtitle="正在读取这一天的任务…">
        <Card>
          <Skeleton lines={2} height={22} />
        </Card>
        <Card>
          <Skeleton lines={5} height={18} />
        </Card>
      </Page>
    )
  }

  if (!day) {
    return (
      <Page title="今日学习">
        <EmptyState title="还没有可显示的内容" action={<Button onClick={() => navigate('/')}>回到学习看板</Button>} />
      </Page>
    )
  }

  return (
    <Page
      title={
        <span className="today-title">
          <span className="today-title__text">
            Day {day.index} · {day.title}
          </span>
          <Badge tone={statusTone(dayStatus)} dot size="sm">
            {DAY_STATUS_LABEL[dayStatus]}
          </Badge>
        </span>
      }
      subtitle={`${day.planTitle} · ${day.goalTitle}`}
      actions={
        <div className="today-head__actions">
          <span className="today-timer" title="本页停留时间，只在本页统计">
            <span className="today-timer__label">已学习</span>
            <span className="today-timer__clock">{clockText(seconds)}</span>
          </span>
          <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
            返回看板
          </Button>
        </div>
      }
    >
      <nav className="today-crumb" aria-label="位置">
        <button type="button" className="today-crumb__link" onClick={() => navigate('/')}>
          学习看板
        </button>
        <span className="today-crumb__sep" aria-hidden="true">
          /
        </span>
        <span className="today-crumb__current">Day {day.index}</span>
      </nav>

      <Tabs
        className="today-tabs"
        tabs={viewTabs}
        value={view}
        onChange={(key) => setView(key)}
        ariaLabel="今日学习视图"
      />

      {view === 'lesson' ? (
        <LessonPanel dayId={day.id} onGoTasks={() => setView('tasks')} />
      ) : (
        <>
          {allDone ? (
            <div className="today-banner" role="status">
              <span className="today-banner__title">任务都勾完了</span>
              <span className="today-banner__text">
                去检测一下：两道客观题，再把今天学到的讲给一个零基础新人听。
              </span>
            </div>
          ) : null}

          <Card className="today-goal" title="今日目标" subtitle={`预计 ${formatMinutes(day.estMinutes)}`}>
            <p className="today-goal__text">{day.goal || '这一天还没有写目标。'}</p>
            {day.checkpoints.length > 0 ? (
              <ol className="today-checks">
                {day.checkpoints.map((item, index) => (
                  <li className="today-checks__item" key={`${index}-${item}`}>
                    <span className="today-checks__num" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="today-checks__text">{item}</span>
                  </li>
                ))}
              </ol>
            ) : null}
          </Card>

          <Card
            className="today-tasks"
            title="任务清单"
            subtitle={`${doneCount} / ${totalCount} 已完成`}
            flush
          >
            {totalCount === 0 ? (
              <div className="today-tasks__pad">
                <EmptyState title="这一天还没有任务" description="回到看板换一天，或重新生成计划。" />
              </div>
            ) : (
              <ul className="today-list">
                {tasks.map((task) => {
                  const done = task.status === 'done'
                  const doing = task.status === 'doing'
                  const saving = pendingIds.includes(task.id)
                  return (
                    <li
                      key={task.id}
                      className={[
                        'today-task',
                        done ? 'is-done' : '',
                        doing ? 'is-doing' : '',
                        saving ? 'is-saving' : ''
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <input
                        className="today-task__box"
                        type="checkbox"
                        id={`sf-task-${task.id}`}
                        checked={done}
                        disabled={saving}
                        onChange={(event: ChangeEvent<HTMLInputElement>) => {
                          changeStatus(task, event.target.checked ? 'done' : 'todo')
                        }}
                        aria-label={done ? `取消完成：${task.title}` : `标记完成：${task.title}`}
                      />
                      <label className="today-task__main" htmlFor={`sf-task-${task.id}`}>
                        <span className="today-task__title">{task.title}</span>
                        <span className="today-task__meta">
                          <span className="today-task__kind">{TASK_KIND_LABEL[task.kind]}</span>
                          <span className="today-task__dot" aria-hidden="true">
                            ·
                          </span>
                          <span className="today-task__min">{task.estMinutes} 分钟</span>
                          {doing && !done ? (
                            <span className="today-task__state">{TASK_STATUS_LABEL.doing}</span>
                          ) : null}
                        </span>
                      </label>
                      {done ? null : (
                        <Button
                          className="today-task__flag"
                          size="sm"
                          variant="ghost"
                          disabled={saving}
                          onClick={() => changeStatus(task, doing ? 'todo' : 'doing')}
                        >
                          {doing ? '取消进行中' : '进行中'}
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>

          {taskError ? <ErrorState error={taskError} compact onRetry={() => void load()} /> : null}
          {examError ? <ErrorState error={examError} compact onRetry={() => void startExam()} /> : null}
        </>
      )}

      {view === 'tasks' ? (
        <footer className="today-bar">
          <div className="today-bar__info">
            {creating ? (
            <span className="today-bar__stage">
              <Spinner size={12} /> 正在出题…
              <span className="today-bar__hint">按今天的材料生成客观题和问答，通常 10–30 秒。</span>
            </span>
          ) : allDone ? (
            <span className="today-bar__ok">
              共 {totalCount} 个任务，全部完成
              <span className="today-bar__hint">
                {day.examId ? '检测已生成，可以接着做。' : '可以开始今天的检测了。'}
              </span>
            </span>
          ) : (
            <span>
              还有 {remaining} 个任务
              <span className="today-bar__hint">也可以直接检测，不勾任务也行。</span>
            </span>
          )}
        </div>
        <div className="today-bar__actions">
          {dayStatus === 'passed' || dayStatus === 'partial' ? (
            <>
              <span className="today-bar__score">成绩 {day.score ?? '—'} 分</span>
              {day.examId ? (
                <Button variant="ghost" onClick={() => navigate(`/exam/${day.examId ?? ''}`)}>
                  查看成绩
                </Button>
              ) : null}
              <Button onClick={() => void startExam()} loading={creating}>
                重新检测
              </Button>
            </>
          ) : dayStatus === 'failed' ? (
            <>
              {day.examId ? (
                <Button variant="ghost" onClick={() => navigate(`/exam/${day.examId ?? ''}`)}>
                  查看上次结果
                </Button>
              ) : null}
              <Button onClick={() => void startExam()} loading={creating}>
                重新检测
              </Button>
            </>
          ) : !allDone ? (
            <>
              {day.examId ? (
                <Button variant="ghost" onClick={() => navigate(`/exam/${day.examId ?? ''}`)}>
                  继续上次检测
                </Button>
              ) : null}
              <Button variant="ghost" onClick={() => void startExam()} loading={creating}>
                直接检测
              </Button>
            </>
          ) : day.examId ? (
            <Button onClick={() => navigate(`/exam/${day.examId ?? ''}`)}>继续上次检测</Button>
          ) : (
            <Button onClick={() => void startExam()} loading={creating}>
              {creating ? '正在出题…' : '开始检测'}
            </Button>
          )}
        </div>
      </footer>
      ) : null}
    </Page>
  )
}
