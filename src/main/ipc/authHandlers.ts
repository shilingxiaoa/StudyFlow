/**
 * 账号类通道：登录 / 注册 / 退出 / 改密码。
 * 这些通道在「未登录」状态下也必须可用，所以它们不碰 repo（也就不会触发 ensureReady 的登录校验）。
 * 每次状态变化都会广播 push:authChanged，让界面（以及自动化脚本）立刻跟上。
 */
import type { AuthStatus } from '../../shared/contracts'
import { IPC, PUSH } from '../../shared/contracts'
import { AppError, handle } from './handle'
import { pickString } from '../db/payload'
import { broadcast } from '../db/bus'
import * as auth from '../auth/service'

function requireField(payload: unknown, key: string, label: string): string {
  const value = (pickString(payload, key) ?? '').trim()
  if (!value) throw new AppError('VALIDATION', `请填写${label}`)
  return value
}

function announce(status: AuthStatus): AuthStatus {
  broadcast(PUSH.AUTH_CHANGED, status)
  return status
}

export function registerAuthHandlers(): void {
  handle<unknown, AuthStatus>(IPC.AUTH_STATUS, () => auth.authStatus())

  handle<unknown, AuthStatus>(IPC.AUTH_REGISTER, async (payload) => {
    const email = requireField(payload, 'email', '邮箱')
    const password = pickString(payload, 'password') ?? ''
    const displayName = pickString(payload, 'displayName') ?? undefined
    if (!password) throw new AppError('VALIDATION', '请填写密码')
    return announce(await auth.register({ email, password, displayName }))
  })

  handle<unknown, AuthStatus>(IPC.AUTH_LOGIN, async (payload) => {
    const email = requireField(payload, 'email', '邮箱')
    const password = pickString(payload, 'password') ?? ''
    if (!password) throw new AppError('VALIDATION', '请填写密码')
    return announce(await auth.login(email, password))
  })

  handle<unknown, AuthStatus>(IPC.AUTH_LOGOUT, async () => announce(await auth.logout()))

  handle<unknown, AuthStatus>(IPC.AUTH_CHANGE_PASSWORD, async (payload) => {
    const oldPassword = pickString(payload, 'oldPassword') ?? ''
    const newPassword = pickString(payload, 'newPassword') ?? ''
    if (!oldPassword || !newPassword) throw new AppError('VALIDATION', '旧密码和新密码都要填')
    return announce(await auth.changePassword(oldPassword, newPassword))
  })
}
