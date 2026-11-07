/* ============================================================
   StudyFlow · 设置（#/settings）
   分区卡片：账号 / DeepSeek API / 学习偏好 / 提醒与复检 / 学习目标 / 数据管理
   保存策略：每个分区一个显式保存按钮，成功与失败都给 toast
   ============================================================ */
import { useEffect, useState } from 'react'
import type { FormEvent, JSX } from 'react'
import type { AppInfo, AppSettings, AuthStatus, UpdateStatus } from '@shared/contracts'
import { IPC, PUSH } from '@shared/contracts'
import { Page } from '../components/layout'
import {
  Badge,
  Button,
  Card,
  Input,
  Modal,
  Select,
  useToast
} from '../components/ui'
import { call, errorMessage, onPush } from '../lib/api'
import { formatDate, formatMinutes, formatPercent } from '../lib/format'
import { navigate } from '../lib/router'
import { useAppStore } from '../store/app'
import './Settings.css'

type ThemeMode = AppSettings['theme']

const THEME_LABEL: Record<ThemeMode, string> = {
  dark: '深色',
  light: '浅色',
  system: '跟随系统'
}

/** 整数区间校验；不合法返回 null */
function parseRange(raw: string, min: number, max: number): number | null {
  const value = Number(raw.trim())
  if (!Number.isFinite(value) || !Number.isInteger(value)) return null
  if (value < min || value > max) return null
  return value
}

function Switch({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={checked ? 'sf-settings-switch is-on' : 'sf-settings-switch'}
      onClick={() => onChange(!checked)}
    >
      <span className="sf-settings-switch__thumb" />
    </button>
  )
}

export default function Settings(): JSX.Element {
  const boot = useAppStore((state) => state.boot)
  const refresh = useAppStore((state) => state.refresh)
  const { success, danger, warn } = useToast()

  const settings = boot?.settings ?? null
  const goals = boot?.goals ?? []
  const activeGoalId = boot?.activeGoalId ?? null
  const plans = boot?.plans ?? []
  const goal = activeGoalId ? goals.find((item) => item.id === activeGoalId) ?? null : null
  const activePlan = boot?.activePlan ?? null
  const setContext = useAppStore((state) => state.setContext)
  const auth = useAppStore((state) => state.auth)
  const logout = useAppStore((state) => state.logout)
  const refreshAuth = useAppStore((state) => state.refreshAuth)
  const account = auth?.account ?? null

  // ---- 关于与更新 ----
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [upd, setUpd] = useState<UpdateStatus>({
    state: 'idle',
    version: null,
    percent: null,
    message: null,
  })
  const [updBusy, setUpdBusy] = useState(false)

  // 应用信息 + 更新状态（进设置页就看一眼，可能在后台已经检查过）
  useEffect(() => {
    let alive = true
    void call<AppInfo>(IPC.APP_INFO)
      .then((info) => {
        if (alive) setAppInfo(info)
      })
      .catch(() => undefined)
    void call<UpdateStatus>(IPC.UPDATE_STATUS_REQ)
      .then((status) => {
        if (alive) setUpd(status)
      })
      .catch(() => undefined)
    const off = onPush(PUSH.UPDATE_STATUS, (payload) => setUpd(payload as UpdateStatus))
    return () => {
      alive = false
      off()
    }
  }, [])

  async function runUpdate(kind: 'check' | 'download' | 'install'): Promise<void> {
    if (updBusy) return
    setUpdBusy(true)
    try {
      if (kind === 'check') {
        const next = await call<UpdateStatus>(IPC.UPDATE_CHECK)
        setUpd(next)
        if (next.state === 'not-available') success(next.message ?? '已经是最新版本')
        else if (next.state === 'available') success(next.message ?? '发现新版本')
      } else if (kind === 'download') {
        const next = await call<UpdateStatus>(IPC.UPDATE_DOWNLOAD)
        setUpd(next)
      } else {
        await call<UpdateStatus>(IPC.UPDATE_INSTALL)
      }
    } catch (err) {
      danger(errorMessage(err))
    } finally {
      setUpdBusy(false)
    }
  }

  // ---- API ----
  const [keyDraft, setKeyDraft] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  // ---- 学习偏好 ----
  const [dailyDraft, setDailyDraft] = useState('60')
  const [themeDraft, setThemeDraft] = useState<ThemeMode>('dark')
  const [savingPrefs, setSavingPrefs] = useState(false)

  // ---- 提醒与复检 ----
  const [remindEnabled, setRemindEnabled] = useState(false)
  const [remindTime, setRemindTime] = useState('20:00')
  const [reviewEnabled, setReviewEnabled] = useState(true)
  const [reviewEveryDays, setReviewEveryDays] = useState('7')
  const [reviewEveryWeekdays, setReviewEveryWeekdays] = useState('2')
  const [savingRemind, setSavingRemind] = useState(false)

  // ---- 数据管理 ----
  const [confirm, setConfirm] = useState<'goal' | 'plan' | null>(null)
  const [deleting, setDeleting] = useState<'goal' | 'plan' | null>(null)

  // ---- 账号 ----
  const [pwOpen, setPwOpen] = useState(false)
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pwError, setPwError] = useState<string | null>(null)
  const [changingPw, setChangingPw] = useState(false)
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  useEffect(() => {
    if (!settings) return
    setDailyDraft(String(settings.dailyMinutes))
    setThemeDraft(settings.theme)
    setRemindEnabled(settings.remindEnabled)
    setRemindTime(settings.remindTime)
    setReviewEnabled(settings.reviewEnabled)
    setReviewEveryDays(String(settings.reviewEveryDays))
    setReviewEveryWeekdays(String(settings.reviewEveryWeekdays))
  }, [settings])

  async function saveSettings(patch: Partial<AppSettings>, message: string): Promise<boolean> {
    try {
      await call<AppSettings>('settings:update', patch)
      await refresh()
      success(message)
      return true
    } catch (err) {
      danger(errorMessage(err))
      return false
    }
  }

  async function saveApiKey(): Promise<void> {
    const key = keyDraft.trim()
    if (key === '') {
      warn('请输入 API Key')
      return
    }
    setSavingKey(true)
    setTestResult(null)
    try {
      await call<AppSettings>('settings:setApiKey', { key })
      setKeyDraft('')
      await refresh()
      success('API Key 已保存')
    } catch (err) {
      danger(errorMessage(err))
    } finally {
      setSavingKey(false)
    }
  }

  async function testApiKey(): Promise<void> {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await call<{ ok?: boolean; latencyMs?: number; message?: string }>('settings:testApiKey')
      if (result && result.ok === false) {
        const message = result.message ?? '连接失败'
        setTestResult({ ok: false, text: message })
        danger(message)
        return
      }
      const latency = result?.latencyMs
      const text = typeof latency === 'number' ? `连接正常 · ${latency} ms` : '连接正常'
      setTestResult({ ok: true, text })
      success('API Key 验证通过')
    } catch (err) {
      const message = errorMessage(err)
      setTestResult({ ok: false, text: message })
      danger(message)
    } finally {
      setTesting(false)
    }
  }

  async function savePreferences(): Promise<void> {
    const daily = parseRange(dailyDraft, 10, 600)
    if (daily === null) {
      warn('每日可投入时间需为 10–600 之间的整数')
      return
    }
    setSavingPrefs(true)
    const ok = await saveSettings({ dailyMinutes: daily, theme: themeDraft }, '学习偏好已保存')
    setSavingPrefs(false)
    if (ok) {
      setDailyDraft(String(daily))
    }
  }

  async function saveReminders(): Promise<void> {
    if (!/^\d{2}:\d{2}$/.test(remindTime)) {
      warn('提醒时间格式应为 HH:mm')
      return
    }
    const days = parseRange(reviewEveryDays, 1, 90)
    const weekdays = parseRange(reviewEveryWeekdays, 1, 7)
    if (days === null || weekdays === null) {
      warn('复检间隔需为整数：每 1–90 天、每 1–7 个工作日')
      return
    }
    setSavingRemind(true)
    const ok = await saveSettings(
      {
        remindEnabled,
        remindTime,
        reviewEnabled,
        reviewEveryDays: days,
        reviewEveryWeekdays: weekdays
      },
      '提醒与复检设置已保存'
    )
    setSavingRemind(false)
    if (ok) {
      setReviewEveryDays(String(days))
      setReviewEveryWeekdays(String(weekdays))
    }
  }

  async function deleteGoal(): Promise<void> {
    if (!goal) return
    setDeleting('goal')
    try {
      await call<{ ok?: boolean; id?: string }>('goal:delete', { goalId: goal.id })
      setConfirm(null)
      await refresh()
      success('学习目标已删除')
      // 还有别的目标就留在看板，一个都不剩时 App 会自动跳回引导页
      navigate('/')
    } catch (err) {
      danger(errorMessage(err))
    } finally {
      setDeleting(null)
    }
  }

  async function deletePlan(): Promise<void> {
    if (!activePlan) return
    setDeleting('plan')
    try {
      await call<{ ok?: boolean; id?: string }>('plan:delete', { planId: activePlan.id })
      setConfirm(null)
      await refresh()
      success('当前计划已删除')
    } catch (err) {
      danger(errorMessage(err))
    } finally {
      setDeleting(null)
    }
  }

  function closePasswordForm(): void {
    setPwOpen(false)
    setOldPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setPwError(null)
  }

  async function changePassword(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (changingPw) return
    if (oldPassword === '') {
      setPwError('请输入旧密码')
      return
    }
    if (newPassword.length < 8) {
      setPwError('新密码至少 8 位')
      return
    }
    if (newPassword !== confirmPassword) {
      setPwError('两次输入的新密码不一致')
      return
    }

    setChangingPw(true)
    setPwError(null)
    try {
      await call<AuthStatus>(IPC.AUTH_CHANGE_PASSWORD, { oldPassword, newPassword })
      await refreshAuth()
      closePasswordForm()
      success('密码已更新')
    } catch (err) {
      const message = errorMessage(err)
      setPwError(message)
      danger(message)
    } finally {
      setChangingPw(false)
    }
  }

  async function confirmLogout(): Promise<void> {
    setLoggingOut(true)
    try {
      await logout()
      // logout() 失败只 toast 不抛错：只有真的退出了才关弹窗
      if (useAppStore.getState().auth?.authenticated === false) {
        setLogoutOpen(false)
        success('已退出登录')
      }
    } finally {
      setLoggingOut(false)
    }
  }

  if (!boot || !settings) {
    return (
      <Page title="设置" subtitle="应用配置与数据管理">
        <Card>
          <p className="sf-muted">正在读取设置…</p>
        </Card>
      </Page>
    )
  }

  const dailyValid = parseRange(dailyDraft, 10, 600)
  const modelText = settings.model || 'deepseek-flash'

  return (
    <Page title="设置" subtitle="应用配置与数据管理">
      {/* ---------- 账号 ---------- */}
      <Card
        title="账号"
        subtitle="本地账号，只在这台电脑上使用。"
        actions={
          <Badge tone="accent" dot>
            本地
          </Badge>
        }
      >
        {account === null ? (
          <p className="sf-muted">正在读取账号…</p>
        ) : (
          <div className="sf-settings__account">
            <div className="sf-settings__account-head">
              <span className="sf-settings__account-avatar" aria-hidden="true">
                {account.displayName.trim().charAt(0) || account.email.trim().charAt(0) || '?'}
              </span>
              <div className="sf-settings__account-main">
                <span className="sf-settings__account-name">{account.displayName}</span>
                <span className="sf-settings__account-mail">{account.email}</span>
              </div>
            </div>

            <dl className="sf-settings__account-facts">
              <div className="sf-settings__account-fact">
                <dt>注册时间</dt>
                <dd>{formatDate(account.createdAt, { withYear: true, withWeekday: false })}</dd>
              </div>
              <div className="sf-settings__account-fact">
                <dt>上次登录</dt>
                <dd>
                  {account.lastLoginAt !== null
                    ? formatDate(account.lastLoginAt, { withYear: true, withWeekday: false })
                    : '本次是第一次登录'}
                </dd>
              </div>
            </dl>

            <p className="sf-settings__account-note">数据只在这台电脑上，退出登录不会删除数据。</p>

            <div className="sf-settings__account-actions">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (pwOpen) closePasswordForm()
                  else setPwOpen(true)
                }}
              >
                {pwOpen ? '收起修改密码' : '修改密码'}
              </Button>
              <Button size="sm" variant="danger" onClick={() => setLogoutOpen(true)}>
                退出登录
              </Button>
            </div>

            {pwOpen ? (
              <form className="sf-settings__account-form" onSubmit={(event) => void changePassword(event)} noValidate>
                <div className="sf-settings__account-form-grid">
                  <Input
                    label="旧密码"
                    type="password"
                    autoComplete="current-password"
                    value={oldPassword}
                    disabled={changingPw}
                    onChange={(event) => setOldPassword(event.target.value)}
                  />
                  <Input
                    label="新密码"
                    type="password"
                    autoComplete="new-password"
                    hint="至少 8 位。"
                    value={newPassword}
                    disabled={changingPw}
                    onChange={(event) => setNewPassword(event.target.value)}
                  />
                  <Input
                    label="确认新密码"
                    type="password"
                    autoComplete="new-password"
                    value={confirmPassword}
                    disabled={changingPw}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                  />
                </div>
                {pwError !== null ? (
                  <p className="sf-settings__account-error" role="alert">
                    {pwError}
                  </p>
                ) : null}
                <div className="sf-settings__account-form-actions">
                  <Button size="sm" variant="ghost" type="button" disabled={changingPw} onClick={closePasswordForm}>
                    取消
                  </Button>
                  <Button size="sm" type="submit" loading={changingPw}>
                    保存新密码
                  </Button>
                </div>
              </form>
            ) : null}
          </div>
        )}
      </Card>

      {/* ---------- DeepSeek API ---------- */}
      <Card
        title="DeepSeek API"
        subtitle="计划生成、评分与复检都通过 DeepSeek 完成。"
        actions={
          settings.hasApiKey ? (
            <Badge tone="success" dot>
              已配置 ✓
            </Badge>
          ) : (
            <Badge tone="warn" dot>
              未配置
            </Badge>
          )
        }
      >
        <div className="sf-settings__form">
          <Input
            label="API Key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={settings.hasApiKey ? '已保存，输入新 Key 可覆盖' : 'sk-...'}
            hint="在 platform.deepseek.com 创建；Key 只保存在本机，不会上传。"
            value={keyDraft}
            onChange={(event) => setKeyDraft(event.target.value)}
          />
          <Input
            label="当前模型"
            value={modelText}
            readOnly
            hint="模型固定为 deepseek-flash，暂不支持切换。"
          />
        </div>
        <div className="sf-settings__actions">
          <div className="sf-settings__status" role="status" aria-live="polite">
            {testResult ? (
              <span className={testResult.ok ? 'sf-settings__ok' : 'sf-settings__bad'}>
                {testResult.ok ? '✓ ' : '✕ '}
                {testResult.text}
              </span>
            ) : (
              <span className="sf-faint">
                {settings.hasApiKey ? 'Key 已配置，可以测试连通性。' : '还没有配置 Key，生成计划前必须先配置。'}
              </span>
            )}
          </div>
          <div className="sf-settings__buttons">
            <Button
              variant="ghost"
              size="sm"
              loading={testing}
              disabled={!settings.hasApiKey}
              onClick={() => void testApiKey()}
            >
              测试连通性
            </Button>
            <Button size="sm" loading={savingKey} onClick={() => void saveApiKey()}>
              验证并保存
            </Button>
          </div>
        </div>
      </Card>

      {/* ---------- 学习偏好 ---------- */}
      <Card title="学习偏好" subtitle="影响计划里每天的任务量与界面外观。">
        <div className="sf-settings__form sf-settings__form--row">
          <Input
            label="每日可投入时间（分钟）"
            type="number"
            min={10}
            max={600}
            step={5}
            value={dailyDraft}
            onChange={(event) => setDailyDraft(event.target.value)}
            error={dailyDraft.trim() !== '' && dailyValid === null ? '请输入 10–600 之间的整数' : undefined}
            hint={
              dailyValid !== null ? `约 ${formatMinutes(dailyValid)}` : '生成计划时按这个时长安排每日任务。'
            }
          />
          <Select
            label="主题"
            value={themeDraft}
            onChange={(event) => setThemeDraft(event.target.value as ThemeMode)}
            hint="保存后立即生效。"
          >
            <option value="dark">{THEME_LABEL.dark}</option>
            <option value="light">{THEME_LABEL.light}</option>
            <option value="system">{THEME_LABEL.system}</option>
          </Select>
        </div>
        <div className="sf-settings__actions">
          <span className="sf-faint">修改后点保存生效。</span>
          <Button size="sm" loading={savingPrefs} onClick={() => void savePreferences()}>
            保存偏好
          </Button>
        </div>
      </Card>

      {/* ---------- 提醒与复检 ---------- */}
      <Card title="提醒与复检" subtitle="按天推送提醒，并定期安排旧内容复检。">
        <div className="sf-settings__rows">
          <div className="sf-settings__row">
            <div className="sf-settings__row-text">
              <span className="sf-settings__row-title">每日学习提醒</span>
              <span className="sf-settings__row-desc">到点提醒你打开今日计划。</span>
            </div>
            <Switch checked={remindEnabled} onChange={setRemindEnabled} label="每日学习提醒" />
          </div>
          <div className="sf-settings__row">
            <div className="sf-settings__row-text">
              <span className="sf-settings__row-title">提醒时间</span>
              <span className="sf-settings__row-desc">24 小时制，例如 20:00。</span>
            </div>
            <Input
              size="sm"
              type="time"
              aria-label="提醒时间"
              value={remindTime}
              disabled={!remindEnabled}
              onChange={(event) => setRemindTime(event.target.value)}
            />
          </div>
          <div className="sf-settings__row">
            <div className="sf-settings__row-text">
              <span className="sf-settings__row-title">自动复检</span>
              <span className="sf-settings__row-desc">按间隔把旧内容插入计划，检验是否真的掌握。</span>
            </div>
            <Switch checked={reviewEnabled} onChange={setReviewEnabled} label="自动复检" />
          </div>
          <div className="sf-settings__row">
            <div className="sf-settings__row-text">
              <span className="sf-settings__row-title">复检间隔（天）</span>
              <span className="sf-settings__row-desc">每 N 天安排一次复检，1–90。</span>
            </div>
            <Input
              size="sm"
              type="number"
              min={1}
              max={90}
              aria-label="复检间隔天数"
              value={reviewEveryDays}
              disabled={!reviewEnabled}
              onChange={(event) => setReviewEveryDays(event.target.value)}
              className="sf-settings__num"
            />
          </div>
          <div className="sf-settings__row">
            <div className="sf-settings__row-text">
              <span className="sf-settings__row-title">复检覆盖（工作日）</span>
              <span className="sf-settings__row-desc">连续 N 个工作日安排复检，1–7。</span>
            </div>
            <Input
              size="sm"
              type="number"
              min={1}
              max={7}
              aria-label="复检覆盖工作日"
              value={reviewEveryWeekdays}
              disabled={!reviewEnabled}
              onChange={(event) => setReviewEveryWeekdays(event.target.value)}
              className="sf-settings__num"
            />
          </div>
        </div>
        <div className="sf-settings__actions">
          <span className="sf-faint">提醒由应用在本地发出，无需联网。</span>
          <Button size="sm" loading={savingRemind} onClick={() => void saveReminders()}>
            保存提醒设置
          </Button>
        </div>
      </Card>

      {/* ---------- 学习目标与计划 ---------- */}
      <Card
        title="学习目标与计划"
        subtitle="可以同时有多个目标，每个目标下也可以有多份计划，切换随时生效。"
        actions={
          <Button size="sm" variant="ghost" onClick={() => navigate('/setup')}>
            新建目标
          </Button>
        }
      >
        {goals.length === 0 ? (
          <p className="sf-muted">还没有学习目标，先到引导页创建一个。</p>
        ) : (
          <ul className="sf-settings__goals">
            {goals.map((item) => {
              const current = item.id === activeGoalId
              return (
                <li key={item.id} className={current ? 'sf-settings__goal is-current' : 'sf-settings__goal'}>
                  <div className="sf-settings__goal-main">
                    <span className="sf-settings__row-title">{item.title}</span>
                    <span className="sf-settings__row-desc">
                      进度 {formatPercent(item.progress)} · 每天 {formatMinutes(item.dailyMinutes)}
                      {current && plans.length > 0 ? ` · 当前目标下 ${plans.length} 份计划` : ''}
                    </span>
                  </div>
                  {current ? (
                    <Badge tone="accent" dot>
                      当前
                    </Badge>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void setContext({ goalId: item.id })}
                    >
                      切换
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {/* ---------- 数据管理 ---------- */}
      <Card title="数据管理" subtitle="所有数据都保存在本机，删除后无法恢复。">        <div className="sf-settings__rows">
          <div className="sf-settings__row">
            <div className="sf-settings__row-text">
              <span className="sf-settings__row-title">数据库位置</span>
              <span className="sf-settings__row-desc">
                <code className="sf-settings__code">%APPDATA%\StudyFlow</code>
                <span className="sf-faint">（数据库与导出的报告都在这里）</span>
              </span>
            </div>
          </div>
          <div className="sf-settings__row">
            <div className="sf-settings__row-text">
              <span className="sf-settings__row-title">删除当前目标</span>
              <span className="sf-settings__row-desc">
                {goal ? `「${goal.title}」及其计划、进度记录会被一起删除。` : '当前还没有学习目标。'}
              </span>
            </div>
            <Button
              variant="danger"
              size="sm"
              disabled={!goal}
              onClick={() => setConfirm('goal')}
            >
              删除目标
            </Button>
          </div>
          <div className="sf-settings__row">
            <div className="sf-settings__row-text">
              <span className="sf-settings__row-title">删除当前计划</span>
              <span className="sf-settings__row-desc">
                {activePlan
                  ? `「${activePlan.title}」共 ${activePlan.totalDays} 天，删除后需要重新生成。`
                  : '当前没有进行中的计划。'}
              </span>
            </div>
            <Button
              variant="danger"
              size="sm"
              disabled={!activePlan}
              onClick={() => setConfirm('plan')}
            >
              删除计划
            </Button>
          </div>
        </div>
      </Card>

      <Card
        title="关于与更新"
        subtitle="当前版本、检查更新、运行环境。"
        actions={
          <Badge tone={upd.state === 'ready' ? 'success' : upd.state === 'available' ? 'warn' : 'neutral'}>
            {updBusy ? '处理中…' : (upd.message ?? `v${appInfo?.version ?? '—'}`)}
          </Badge>
        }
      >
        <div className="sf-settings__rows">
          <div className="sf-settings__row">
            <div className="sf-settings__row-text">
              <span className="sf-settings__row-title">StudyFlow v{appInfo?.version ?? '—'}</span>
              <span className="sf-settings__row-desc">
                {appInfo?.packaged ? '安装版' : '开发版（源码运行）'}
                {appInfo ? ` · Electron ${appInfo.electron} · ${appInfo.platform}` : ''}
              </span>
            </div>
            {upd.state === 'available' ? (
              <Button size="sm" loading={updBusy} onClick={() => void runUpdate('download')}>
                下载 v{upd.version}
              </Button>
            ) : upd.state === 'ready' ? (
              <Button size="sm" variant="primary" loading={updBusy} onClick={() => void runUpdate('install')}>
                重启并安装 v{upd.version}
              </Button>
            ) : (
              <Button size="sm" loading={updBusy} onClick={() => void runUpdate('check')}>
                检查更新
              </Button>
            )}
          </div>
          <div className="sf-settings__row">
            <div className="sf-settings__row-text">
              <span className="sf-settings__row-title">更新说明</span>
              <span className="sf-settings__row-desc">
                启动后会自动检查一次；新版本会提示，不会自动替换正在用的版本。
                {upd.state === 'downloading' ? ` 正在下载 ${upd.percent ?? 0}%` : ''}
              </span>
            </div>
          </div>
        </div>
      </Card>

      <Modal
        open={confirm === 'goal'}
        title="删除当前目标？"
        onClose={() => {
          if (deleting === null) setConfirm(null)
        }}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)} disabled={deleting !== null}>
              取消
            </Button>
            <Button variant="danger" loading={deleting === 'goal'} onClick={() => void deleteGoal()}>
              确认删除
            </Button>
          </>
        }
      >
        <p className="sf-settings__modal-text">
          目标「{goal?.title ?? ''}」以及它关联的计划、每日任务和进度记录都会被删除，且无法撤销。
        </p>
      </Modal>

      <Modal
        open={confirm === 'plan'}
        title="删除当前计划？"
        onClose={() => {
          if (deleting === null) setConfirm(null)
        }}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)} disabled={deleting !== null}>
              取消
            </Button>
            <Button variant="danger" loading={deleting === 'plan'} onClick={() => void deletePlan()}>
              确认删除
            </Button>
          </>
        }
      >
        <p className="sf-settings__modal-text">
          计划「{activePlan?.title ?? ''}」会被删除，目标会保留；之后可以重新生成计划。
        </p>
      </Modal>

      <Modal
        open={logoutOpen}
        title="退出登录？"
        onClose={() => {
          if (!loggingOut) setLogoutOpen(false)
        }}
        footer={
          <>
            <Button variant="ghost" onClick={() => setLogoutOpen(false)} disabled={loggingOut}>
              取消
            </Button>
            <Button variant="danger" loading={loggingOut} onClick={() => void confirmLogout()}>
              退出登录
            </Button>
          </>
        }
      >
        <p className="sf-settings__modal-text">
          退出后会回到登录页；学习数据只保存在这台电脑上，退出登录不会删除数据，重新登录即可继续。
        </p>
      </Modal>
    </Page>
  )
}
