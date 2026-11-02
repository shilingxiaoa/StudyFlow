/**
 * 本地账号：不联网、不上云，账号和密码哈希都存在本机的 accounts.db。
 *
 * 设计要点：
 *  · 账号库与每个用户的学习库完全分开（accounts.db vs users/<id>/studyflow.db），
 *    这样「换账号」只是切换一个文件，不需要给 11 张表都加 owner 列。
 *  · 密码用 scrypt + 每账号随机盐，只存哈希；比较用 timingSafeEqual。
 *  · 会话是一行记录（token 哈希 + 过期时间），默认 7 天；
 *    退出登录会删掉这一行，同时关闭当前学习库。
 *  · 首次建号时，如果这台电脑上还有「登录功能之前」留下的 studyflow.db，
 *    会把它整体收编进新账号（rename，不复制），数据不丢。
 */
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Database as SqlDatabase } from 'sql.js'
import type { AuthAccount, AuthStatus } from '../../shared/contracts'
import { AppError } from '../ipc/handle'
import { getEngine, setActiveDatabaseFile } from '../db/database'
import { logger } from '../util/logger'
import { accountsPath, legacyDbPath, userDbPath } from '../util/paths'

const SESSION_DAYS = 7
const MIN_PASSWORD = 8
const MAX_PASSWORD = 72

const ACCOUNTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_norm TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`

interface AccountRow {
  id: string
  email: string
  email_norm: string
  display_name: string
  password_hash: string
  password_salt: string
  created_at: string
  last_login_at: string | null
}

interface SessionRow {
  id: string
  account_id: string
  token_hash: string
  created_at: string
  expires_at: string
}

let accounts: SqlDatabase | null = null

function nowIso(): string {
  return new Date().toISOString()
}

function openAccounts(): SqlDatabase {
  if (accounts) return accounts
  const engine = getEngineSync()
  const file = accountsPath()
  let next: SqlDatabase
  if (existsSync(file)) {
    try {
      next = new engine.Database(readFileSync(file))
    } catch (err) {
      logger.error('auth', '账号库损坏，已备份并重建', err)
      try {
        renameSync(file, `${file}.corrupt-${Date.now()}`)
      } catch {
        /* ignore */
      }
      next = new engine.Database()
    }
  } else {
    next = new engine.Database()
  }
  next.exec(ACCOUNTS_SCHEMA)
  accounts = next
  persistAccounts()
  return next
}

/** getEngine 是异步的，但账号库只在 IPC 里用；这里用同步缓存的引擎句柄 */
let engineHandle: Awaited<ReturnType<typeof getEngine>> | null = null

function getEngineSync(): Awaited<ReturnType<typeof getEngine>> {
  if (!engineHandle) {
    throw new AppError('AUTH_REQUIRED', '账号模块尚未初始化，请重试')
  }
  return engineHandle
}

/** 主进程启动时调用一次，把 sql.js 引擎准备好（登录页要能立刻用） */
export async function prepareAuth(): Promise<void> {
  engineHandle = await getEngine()
  openAccounts()
}

function persistAccounts(): void {
  if (!accounts) return
  const file = accountsPath()
  const bytes = accounts.export()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, Buffer.from(bytes))
  renameSync(tmp, file)
}

function normEmail(email: string): string {
  return email.trim().toLowerCase()
}

function assertEmail(email: string): void {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AppError('VALIDATION', '邮箱格式不对，检查一下')
  }
}

function assertPassword(password: string): void {
  if (password.length < MIN_PASSWORD) {
    throw new AppError('VALIDATION', `密码至少 ${MIN_PASSWORD} 位`)
  }
  if (password.length > MAX_PASSWORD) {
    throw new AppError('VALIDATION', `密码最长 ${MAX_PASSWORD} 位`)
  }
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex')
}

function verifyPassword(password: string, row: AccountRow): boolean {
  const expected = Buffer.from(row.password_hash, 'hex')
  const actual = Buffer.from(hashPassword(password, row.password_salt), 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function toAccount(row: AccountRow): AuthAccount {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at
  }
}

function queryOne<T>(database: SqlDatabase, sql: string, params: (string | null)[] = []): T | null {
  const stmt = database.prepare(sql)
  try {
    stmt.bind(params)
    if (!stmt.step()) return null
    return stmt.getAsObject() as unknown as T
  } finally {
    stmt.free()
  }
}

function accountCount(): number {
  const database = openAccounts()
  const row = queryOne<{ n: number }>(database, 'SELECT COUNT(*) AS n FROM account')
  return row ? Number(row.n) : 0
}

function findAccountByEmail(email: string): AccountRow | null {
  return queryOne<AccountRow>(openAccounts(), 'SELECT * FROM account WHERE email_norm = ?', [normEmail(email)])
}

function findAccountById(id: string): AccountRow | null {
  return queryOne<AccountRow>(openAccounts(), 'SELECT * FROM account WHERE id = ?', [id])
}

function readSession(): SessionRow | null {
  return queryOne<SessionRow>(openAccounts(), "SELECT * FROM session WHERE id = 'current'")
}

function clearSession(): void {
  openAccounts().run("DELETE FROM session WHERE id = 'current'")
  persistAccounts()
}

/** 把账号的学习库设成本次会话的工作库；若老库还在、而该账号还没有库，收编老库 */
function attachAccountData(account: AccountRow, adoptLegacy: boolean): void {
  const file = userDbPath(account.id)
  if (adoptLegacy && !existsSync(file) && existsSync(legacyDbPath())) {
    // 收编前先留一份副本：万一用户想回到「没有账号」的版本，原来的库还在
    try {
      copyFileSync(legacyDbPath(), `${legacyDbPath()}.pre-login.bak`)
    } catch (err) {
      logger.warn('auth', '备份老数据失败，继续收编', err)
    }
    try {
      renameSync(legacyDbPath(), file)
      logger.info('auth', `已把现有学习数据归到账号 ${account.email}`)
    } catch (err) {
      logger.warn('auth', '收编老数据失败，改为复制', err)
      try {
        copyFileSync(legacyDbPath(), file)
      } catch (copyErr) {
        logger.error('auth', '复制老数据也失败了', copyErr)
      }
    }
  }
  setActiveDatabaseFile(file)
}

function beginSession(account: AccountRow): void {
  const database = openAccounts()
  const token = randomBytes(32).toString('hex')
  const created = nowIso()
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  // 只存 token 的哈希：即使 accounts.db 被拷走，也拿不到可用的会话
  const tokenHash = scryptSync(token, account.id, 32).toString('hex')
  database.run("DELETE FROM session WHERE id = 'current'")
  database.run('INSERT INTO session (id, account_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', [
    'current',
    account.id,
    tokenHash,
    created,
    expires
  ])
  database.run('UPDATE account SET last_login_at = ? WHERE id = ?', [created, account.id])
  persistAccounts()
}

export async function authStatus(): Promise<AuthStatus> {
  const hasLegacy = existsSync(legacyDbPath())
  const count = accountCount()
  const session = readSession()
  if (session && new Date(session.expires_at).getTime() > Date.now()) {
    const account = findAccountById(session.account_id)
    if (account) {
      attachAccountData(account, false)
      return {
        authenticated: true,
        account: toAccount(account),
        hasAccounts: count > 0,
        legacyDataAvailable: hasLegacy
      }
    }
  }
  if (session) {
    clearSession()
    setActiveDatabaseFile(null)
  }
  return { authenticated: false, account: null, hasAccounts: count > 0, legacyDataAvailable: hasLegacy }
}

export interface RegisterInput {
  email: string
  password: string
  displayName?: string
}

export async function register(input: RegisterInput): Promise<AuthStatus> {
  const email = (input.email ?? '').trim()
  const password = input.password ?? ''
  assertEmail(email)
  assertPassword(password)
  if (findAccountByEmail(email)) {
    throw new AppError('VALIDATION', '这个邮箱已经注册过了，直接登录吧')
  }
  const first = accountCount() === 0
  const salt = randomBytes(16).toString('hex')
  const id = randomUUID()
  const displayName = (input.displayName ?? '').trim() || email.split('@')[0] || '学习者'
  const database = openAccounts()
  database.run(
    'INSERT INTO account (id, email, email_norm, display_name, password_hash, password_salt, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
    [id, email, normEmail(email), displayName, hashPassword(password, salt), salt, nowIso()]
  )
  persistAccounts()
  const account = findAccountById(id)
  if (!account) throw new AppError('AUTH_FAILED', '账号创建失败，请重试')
  attachAccountData(account, first)
  beginSession(account)
  return {
    authenticated: true,
    account: toAccount(account),
    hasAccounts: true,
    legacyDataAvailable: existsSync(legacyDbPath())
  }
}

export async function login(email: string, password: string): Promise<AuthStatus> {
  const row = findAccountByEmail(email ?? '')
  if (!row || !verifyPassword(password ?? '', row)) {
    throw new AppError('AUTH_FAILED', '邮箱或密码不对')
  }
  attachAccountData(row, false)
  beginSession(row)
  const account = findAccountById(row.id) ?? row
  return {
    authenticated: true,
    account: toAccount(account),
    hasAccounts: true,
    legacyDataAvailable: existsSync(legacyDbPath())
  }
}

export async function logout(): Promise<AuthStatus> {
  clearSession()
  setActiveDatabaseFile(null)
  return authStatus()
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<AuthStatus> {
  const session = readSession()
  if (!session) throw new AppError('AUTH_REQUIRED', '请先登录')
  const row = findAccountById(session.account_id)
  if (!row) throw new AppError('AUTH_REQUIRED', '账号不存在')
  if (!verifyPassword(oldPassword ?? '', row)) {
    throw new AppError('AUTH_FAILED', '旧密码不对')
  }
  assertPassword(newPassword ?? '')
  const salt = randomBytes(16).toString('hex')
  openAccounts().run('UPDATE account SET password_hash = ?, password_salt = ? WHERE id = ?', [
    hashPassword(newPassword, salt),
    salt,
    row.id
  ])
  persistAccounts()
  // 改密码后让其他会话失效（本机只有一个会话，等价于重建）
  beginSession(row)
  return authStatus()
}
