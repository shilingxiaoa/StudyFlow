/**
 * sql.js（SQLite WASM）数据库引擎封装。
 *
 * 设计要点：
 *  · WASM 用 createRequire 定位真实文件路径 + readFileSync 读入 → 打包成 asar 后依然可用
 *    （Electron 的 fs 补丁能读 asar 内的文件；若用 sql.js 默认的 fetch/locateFile 会失败）
 *  · 整个库常驻内存，写操作后防抖 300ms 导出成文件：先写 .tmp 再 rename 原子替换
 *  · 退出前调用 flushSync()，保证不丢数据
 *  · 所有 SQL 一律走参数绑定，禁止字符串拼接用户输入
 */
import initSqlJs from 'sql.js'
import type { Database as SqlDatabase, SqlValue } from 'sql.js'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dbPath } from '../util/paths'
import { logger } from '../util/logger'
import { AppError } from '../ipc/handle'
import SCHEMA_SQL from './schema.sql?raw'

const nodeRequire = createRequire(__filename)

/** 参数只允许 SQLite 认识的标量；布尔请在外面转成 0/1 */
export type Params = SqlValue[]
export type Row = Record<string, SqlValue>

const PERSIST_DEBOUNCE_MS = 300

let db: SqlDatabase | null = null
let booting: Promise<void> | null = null
let persistTimer: NodeJS.Timeout | null = null
let dirty = false
let txDepth = 0

function locateWasm(): string {
  const candidates: string[] = []
  try {
    candidates.push(nodeRequire.resolve('sql.js/dist/sql-wasm.wasm'))
  } catch {
    /* 某些环境 exports 字段不允许子路径，走下面的兜底 */
  }
  try {
    candidates.push(join(dirname(nodeRequire.resolve('sql.js')), 'sql-wasm.wasm'))
  } catch {
    /* ignore */
  }
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  throw new AppError('DB', '数据库引擎初始化失败：找不到 sql.js 的 sql-wasm.wasm')
}

async function bootstrap(): Promise<void> {
  const bytes = readFileSync(locateWasm())
  // 复制成独立的 ArrayBuffer，避免 Buffer 内存池偏移问题
  const wasmBinary = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const SQL = await initSqlJs({ wasmBinary })

  const file = dbPath()
  let next: SqlDatabase
  if (existsSync(file)) {
    try {
      next = new SQL.Database(readFileSync(file))
    } catch (err) {
      logger.error('db', '数据库文件损坏，已备份并重建', err)
      try {
        renameSync(file, `${file}.corrupt-${Date.now()}`)
      } catch {
        /* ignore */
      }
      next = new SQL.Database()
    }
  } else {
    next = new SQL.Database()
  }

  // sql.js 默认不开启外键约束，必须每个连接手动打开
  next.exec('PRAGMA foreign_keys = ON;')
  next.exec(SCHEMA_SQL)

  // v1.3 取消「解锁」机制：老库里被标成 locked 的 Day 一律改成可学习，
  // 这样升级后历史计划里的后半段也能直接点进去学 / 直接检测。
  next.exec("UPDATE day SET status = 'learning' WHERE status = 'locked'")

  // 兜底自愈：历史版本或异常退出可能留下孤儿子行（级联删除未生效时），启动时清一次
  const pruned = pruneOrphans(next)
  if (pruned > 0) logger.warn('db', `已清理 ${pruned} 条孤儿数据`)
  db = next

  // 建表 / 清理都只改了内存里的库。这里立刻落盘：
  // 否则新版本追加的表（如 lesson）要等用户下一次写操作才进文件，
  // 期间若进程异常退出，新表就白建了。库只有几百 KB，每次启动写一次可以接受。
  markDirty()
  writeNow()

  logger.info('db', `数据库就绪: ${file}`)
}

/**
 * 按「父在子留」清理孤立行。
 * sql.js 里 PRAGMA foreign_keys 偶发不生效（内存库重建、旧文件等情况），
 * 删除目标时另有一套显式删除，这里是最后一道保险。
 */
const PRUNE_STATEMENTS = [
  'DELETE FROM task WHERE day_id NOT IN (SELECT id FROM day)',
  'DELETE FROM lesson WHERE day_id NOT IN (SELECT id FROM day)',
  'DELETE FROM question WHERE exam_id NOT IN (SELECT id FROM exam)',
  'DELETE FROM recitation WHERE exam_id NOT IN (SELECT id FROM exam)',
  'DELETE FROM exam WHERE day_id NOT IN (SELECT id FROM day)',
  'DELETE FROM day WHERE plan_id NOT IN (SELECT id FROM plan)',
  'DELETE FROM plan WHERE goal_id NOT IN (SELECT id FROM goal)',
  'DELETE FROM progress_event WHERE goal_id NOT IN (SELECT id FROM goal)',
  'DELETE FROM material WHERE goal_id NOT IN (SELECT id FROM goal)'
]

function pruneOrphans(database: SqlDatabase): number {
  let total = 0
  // 子行只有在父行删掉之后才变成孤儿，所以多跑几轮直到不动为止
  for (let pass = 0; pass < 3; pass += 1) {
    let changed = 0
    for (const sql of PRUNE_STATEMENTS) {
      try {
        database.run(sql)
        changed += database.getRowsModified()
      } catch (err) {
        logger.error('db', `清理孤儿数据失败: ${sql}`, err)
      }
    }
    total += changed
    if (changed === 0) break
  }
  return total
}

/** 幂等初始化；并发调用只会真正初始化一次 */
export async function ensureReady(): Promise<void> {
  if (db) return
  if (!booting) {
    booting = bootstrap().catch((err: unknown) => {
      booting = null
      db = null
      throw err instanceof AppError ? err : new AppError('DB', `数据库初始化失败：${String(err)}`)
    })
  }
  await booting
}

export function isReady(): boolean {
  return db !== null
}

function requireDb(): SqlDatabase {
  if (!db) throw new AppError('DB', '数据库尚未初始化')
  return db
}

function toDbError(err: unknown): Error {
  if (err instanceof AppError) return err
  const msg = err instanceof Error ? err.message : String(err)
  logger.error('db', 'SQL 执行失败', msg)
  return new AppError('DB', `数据库操作失败：${msg}`)
}

/** 当前 SQL 文件路径（导出/备份时用） */
export function dbFilePath(): string {
  return dbPath()
}

/** 执行写语句 */
export function run(sql: string, params: Params = []): void {
  const database = requireDb()
  try {
    database.run(sql, params)
  } catch (err) {
    throw toDbError(err)
  }
  markDirty()
}

/** 查询多行 */
export function all<T = Row>(sql: string, params: Params = []): T[] {
  const database = requireDb()
  try {
    const stmt = database.prepare(sql)
    try {
      if (params.length > 0) stmt.bind(params)
      const rows: T[] = []
      while (stmt.step()) rows.push(stmt.getAsObject() as unknown as T)
      return rows
    } finally {
      stmt.free()
    }
  } catch (err) {
    throw toDbError(err)
  }
}

/** 查询单行 */
export function get<T = Row>(sql: string, params: Params = []): T | null {
  const rows = all<T>(sql, params)
  return rows.length > 0 ? rows[0] : null
}

/**
 * 事务。sql.js 是同步引擎，回调必须是同步函数（不要在事务内 await）。
 * 支持嵌套调用：内层不会重复 BEGIN。
 */
export function transaction<T>(fn: () => T): T {
  const database = requireDb()
  if (txDepth > 0) {
    txDepth += 1
    try {
      return fn()
    } finally {
      txDepth -= 1
    }
  }

  try {
    database.run('BEGIN')
  } catch (err) {
    throw toDbError(err)
  }
  txDepth = 1
  try {
    const result = fn()
    database.run('COMMIT')
    markDirty()
    return result
  } catch (err) {
    try {
      database.run('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw toDbError(err)
  } finally {
    txDepth = 0
  }
}

function markDirty(): void {
  dirty = true
}

/** 导出整库字节 */
function exportBytes(): Uint8Array {
  return requireDb().export()
}

function writeNow(): void {
  if (!db || !dirty) return
  const file = dbPath()
  mkdirSync(dirname(file), { recursive: true })
  const bytes = exportBytes()
  const tmp = `${file}.tmp`
  writeFileSync(tmp, Buffer.from(bytes))
  renameSync(tmp, file)
  dirty = false
}

/** 防抖落盘：写操作后 300ms 内合并成一次写文件（写临时文件再原子替换） */
export function persist(): void {
  markDirty()
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    try {
      writeNow()
    } catch (err) {
      logger.error('db', '数据落盘失败', err)
    }
  }, PERSIST_DEBOUNCE_MS)
}

/** 同步落盘：app.on('before-quit') 时调用，确保退出不丢数据 */
export function flushSync(): void {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  if (!dirty) return
  try {
    writeNow()
    logger.info('db', '退出前已落盘')
  } catch (err) {
    logger.error('db', '退出前落盘失败', err)
  }
}

/** 关闭数据库（测试用） */
export function closeSync(): void {
  flushSync()
  if (db) {
    db.close()
    db = null
    booting = null
  }
}
