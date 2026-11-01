import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/** 应用数据目录（Windows: %APPDATA%/StudyFlow） */
export function userDataDir(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** SQLite 文件路径 */
export function dbPath(): string {
  return join(userDataDir(), 'studyflow.db')
}

/** 导出文件目录 */
export function exportDir(): string {
  const dir = join(userDataDir(), 'exports')
  mkdirSync(dir, { recursive: true })
  return dir
}
