import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/** 应用数据目录（Windows: %APPDATA%/StudyFlow） */
export function userDataDir(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** SQLite 文件路径（引入登录前的老库；现在只作为「待收编」的老数据位置） */
export function dbPath(): string {
  return join(userDataDir(), 'studyflow.db')
}

/** 账号库：保存账号与会话，和每个用户的学习数据分开 */
export function accountsPath(): string {
  return join(userDataDir(), 'accounts.db')
}

/** 某个账号的学习数据文件：users/<id>/studyflow.db */
export function userDbPath(userId: string): string {
  const dir = join(userDataDir(), 'users', userId)
  mkdirSync(dir, { recursive: true })
  return join(dir, 'studyflow.db')
}

/** 老库位置（首次建号时会被收编成该账号的数据） */
export function legacyDbPath(): string {
  return join(userDataDir(), 'studyflow.db')
}

/** 导出文件目录 */
export function exportDir(): string {
  const dir = join(userDataDir(), 'exports')
  mkdirSync(dir, { recursive: true })
  return dir
}
