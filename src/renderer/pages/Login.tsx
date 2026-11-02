/* ============================================================
   StudyFlow · 本地登录 / 创建账号
   - 首次进入自己问主进程要 auth:status（不依赖 store，未登录时 store 还没数据）
   - 没有账号 → 创建账号；已有账号 → 登录，两者可互相切换
   - 成功后重拉 bootstrap 并回学习看板
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, JSX } from 'react'
import type { AuthStatus } from '@shared/contracts'
import { IPC } from '@shared/contracts'
import { Button, Card, ErrorState, Input } from '../components/ui'
import { call, errorMessage } from '../lib/api'
import { navigate } from '../lib/router'
import { useAppStore } from '../store/app'
import './Login.css'

type Mode = 'login' | 'register'

/** 登录页自己的小图标（与启动屏 BrandMark 同一套笔画，避免跨文件耦合） */
function LoginMark(): JSX.Element {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 7.5h9.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M4 12h13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.72" />
      <path d="M4 16.5h6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.45" />
      <path
        d="M15.6 13.2l2.1 2.1 4-4.4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export default function LoginPage(): JSX.Element {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)

  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  /** 用户手动切过模式后，重试读取状态时不要把他切回去 */
  const switchedRef = useRef(false)

  const loadStatus = useCallback(async (): Promise<void> => {
    setStatusLoading(true)
    setStatusError(null)
    try {
      const next = await call<AuthStatus>(IPC.AUTH_STATUS)
      setStatus(next)
      if (!switchedRef.current) setMode(next.hasAccounts ? 'login' : 'register')
    } catch (err) {
      setStatusError(errorMessage(err))
    } finally {
      setStatusLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  function switchMode(next: Mode): void {
    switchedRef.current = true
    setMode(next)
    setSubmitError(null)
    setPassword('')
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (submitting) return

    const trimmedEmail = email.trim()
    const trimmedName = displayName.trim()
    if (!trimmedEmail) {
      setSubmitError('请输入邮箱')
      return
    }
    if (mode === 'login') {
      if (!password) {
        setSubmitError('请输入密码')
        return
      }
    } else if (password.length < 8) {
      setSubmitError('密码至少 8 位')
      return
    }

    setSubmitting(true)
    setSubmitError(null)
    try {
      const next =
        mode === 'login'
          ? await call<AuthStatus>(IPC.AUTH_LOGIN, { email: trimmedEmail, password })
          : await call<AuthStatus>(
              IPC.AUTH_REGISTER,
              trimmedName ? { email: trimmedEmail, password, displayName: trimmedName } : { email: trimmedEmail, password }
            )
      setStatus(next)
      await useAppStore.getState().load()
      navigate('/')
    } catch (err) {
      setSubmitError(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  const creating = mode === 'register'
  const showLegacyNote = creating && status?.legacyDataAvailable === true

  return (
    <div className="sf-login">
      <div className="sf-login__panel">
        <div className="sf-login__brand">
          <span className="sf-login__mark">
            <LoginMark />
          </span>
          <span className="sf-login__brand-name">StudyFlow</span>
          <p className="sf-login__tagline">数据只存在这台电脑上</p>
        </div>

        <Card
          className="sf-login__card"
          title={creating ? '创建你的本地账号' : '登录你的本地账号'}
          subtitle={creating ? '账号建好后就能开始记录学习。' : '用这台电脑上的账号继续。'}
        >
          {statusLoading ? (
            <p className="sf-login__hint">正在读取登录状态…</p>
          ) : statusError !== null ? (
            <ErrorState
              message={statusError}
              onRetry={() => {
                void loadStatus()
              }}
              retryText="重新读取"
            />
          ) : (
            <>
              {showLegacyNote ? (
                <div className="sf-login__note" role="status">
                  这台电脑上已有学习数据，创建账号后会归到这个账号，不会丢。
                </div>
              ) : null}

              <form className="sf-login__form" onSubmit={(event) => void handleSubmit(event)} noValidate>
                <Input
                  label="邮箱"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  autoFocus
                  disabled={submitting}
                  onChange={(event) => setEmail(event.target.value)}
                />
                <Input
                  label="密码"
                  type="password"
                  autoComplete={creating ? 'new-password' : 'current-password'}
                  placeholder={creating ? '至少 8 位' : '输入密码'}
                  hint={creating ? '至少 8 位，只保存在本机。' : undefined}
                  value={password}
                  disabled={submitting}
                  onChange={(event) => setPassword(event.target.value)}
                />
                {creating ? (
                  <Input
                    label="昵称"
                    type="text"
                    autoComplete="nickname"
                    placeholder="可选，默认用邮箱前缀"
                    value={displayName}
                    disabled={submitting}
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                ) : null}

                {submitError !== null ? (
                  <p className="sf-login__error" role="alert">
                    {submitError}
                  </p>
                ) : null}

                <Button type="submit" block size="lg" loading={submitting}>
                  {creating ? '创建账号并进入' : '登录'}
                </Button>
              </form>

              <p className="sf-login__switch">
                {creating ? (
                  <>
                    已有账号？
                    <button type="button" className="sf-login__link" onClick={() => switchMode('login')}>
                      去登录
                    </button>
                  </>
                ) : (
                  <>
                    没有账号？
                    <button type="button" className="sf-login__link" onClick={() => switchMode('register')}>
                      创建一个
                    </button>
                  </>
                )}
              </p>
            </>
          )}
        </Card>

        <p className="sf-login__fineprint">
          账号和密码只保存在本机，不上传服务器；忘记密码无法找回，请在设置里记好。
        </p>
      </div>
    </div>
  )
}
