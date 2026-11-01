/**
 * 薄启动器：先清掉可能被上层 shell 注入的 ELECTRON_RUN_AS_NODE，再转交 electron-vite。
 *
 * 带着这个变量启动时，Electron 会退化成纯 Node 进程，主进程直接报
 * `TypeError: Cannot read properties of undefined (reading 'isPackaged')`，
 * 报错位置在打包后的 out/main/index.js，很难第一眼看出是环境变量的问题。
 *
 * 用法：node scripts/electron-vite-run.mjs dev | preview
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

delete process.env.ELECTRON_RUN_AS_NODE
delete process.env.ELECTRON_NO_ATTACH_CONSOLE

const require = createRequire(import.meta.url)
const cli = join(dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js')
const args = process.argv.slice(2)

const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit', env: process.env })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
