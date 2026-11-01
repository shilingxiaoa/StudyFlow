import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'

/**
 * 自动化冒烟：启动真实 Electron，跑 scripts/smoke-flow.js 里的非 AI 全链路，
 * 打印逐项结果，失败时退出码 1。用法：npm run smoke（会先 build）。
 * 可选参数：node scripts/smoke.mjs <流程脚本> <截图目录>
 * 打包产物校验：node scripts/smoke.mjs --packaged（跑 release/win-unpacked/StudyFlow.exe，无需源码目录）
 */
const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const packaged = process.argv.includes('--packaged')
const electron = require('electron')

const positional = process.argv.slice(2).filter((item) => !item.startsWith('--'))
const flowScript = positional[0] ?? join(here, 'smoke-flow.js')
const shotsDir = positional[1]

// 打包版直接跑 exe，不传项目目录（asar 里已经包含全部代码）
// SF_SMOKE_EXE=<路径> 可以指定任意产物（例如 release/StudyFlow-1.4.0-portable.exe）
const customExe = process.env.SF_SMOKE_EXE
const customPath = customExe ? (isAbsolute(customExe) ? customExe : resolve(root, customExe)) : undefined
const exe = customPath ?? (packaged ? join(root, 'release', 'win-unpacked', 'StudyFlow.exe') : electron)
const exeArgs = customPath || packaged ? [] : ['.']

const env = { ...process.env, SF_SMOKE: '1', SF_SMOKE_SCRIPT: flowScript }
if (shotsDir) env.SF_SHOTS = join(root, shotsDir)
// 数据目录隔离：默认每次冒烟都用一个全新的临时 userData，绝不碰真实库（%APPDATA%/StudyFlow）
// 需要复用已登录的 Key 跑真实 AI 探针时，用 SF_SMOKE_DATA=<相对目录> 指定一个已有目录（不清理）
const smokeData = join(root, process.env.SF_SMOKE_DATA ?? '.tmp-smoke-data')
if (process.env.SF_SMOKE_DATA) {
  console.log(`[smoke] 复用数据目录 ${smokeData}`)
} else {
  rmSync(smokeData, { recursive: true, force: true })
}
env.SF_USER_DATA = smokeData
// 这些变量会让 electron.exe 退化成 Node 进程（app 未定义），必须剔掉
delete env.ELECTRON_RUN_AS_NODE
delete env.SF_SMOKE_RESULT

const child = spawn(exe, exeArgs, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })

let stdout = ''
let stderr = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  stdout += chunk
  process.stdout.write(chunk)
})
child.stderr.on('data', (chunk) => {
  stderr += chunk
})

const timer = setTimeout(() => {
  console.error('\n[smoke] 超时（180s），强制结束')
  child.kill()
}, 180000)

// 主进程的 console.error 走 stderr，留下来方便定位失败原因
const stderrLog = join(root, '.tmp-smoke-stderr.log')

child.on('exit', (code) => {
  clearTimeout(timer)
  try {
    writeFileSync(stderrLog, stderr)
  } catch {
    // 日志写不进去不影响结果判定
  }
  // 探针既可能直接打在 stdout，也可能经渲染进程 console-message 转发（前缀 `[smoke:console:n] `、后缀 ` (:行号)`）
  const raw = stdout
    .split(/\r?\n/)
    .filter((item) => item.includes('[smoke] {'))
    .map((item) => item.slice(item.indexOf('[smoke] {') + '[smoke] '.length))
    .pop()
  const line = raw === undefined ? undefined : raw.slice(0, raw.lastIndexOf('}') + 1)
  if (!line) {
    console.error(`\n[smoke] 没拿到探针输出，退出码 ${code}`)
    if (stderr.trim() !== '') console.error(stderr.split(/\r?\n/).slice(-20).join('\n'))
    process.exit(1)
  }
  let report
  try {
    report = JSON.parse(line)
  } catch (error) {
    console.error('[smoke] 结果解析失败', error)
    console.error('[smoke] 原始行长度', line.length, '尾部', JSON.stringify(line.slice(-80)))
    process.exit(1)
  }

  const failed = report.results.filter((item) => !item.ok)
  console.log(`\n[smoke] 通过 ${report.passed} / 失败 ${report.failed}`)
  for (const item of failed) {
    console.log(`  ✗ ${item.name} ${item.extra === undefined ? '' : JSON.stringify(item.extra)}`)
  }
  if (failed.length > 0) {
    const tail = stderr.split(/\r?\n/).filter((item) => item.trim() !== '').slice(-20)
    if (tail.length > 0) {
      console.log('\n[stderr 尾部]')
      for (const item of tail) console.log(`  ${item}`)
    }
  }
  for (const screen of report.screens ?? []) {
    console.log(`  · ${screen.label.padEnd(10)} ${screen.hash}  nodes=${screen.nodes}`)
  }
  process.exit(report.ok ? 0 : 1)
})
