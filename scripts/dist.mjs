/**
 * 打包入口：先备好国内镜像环境变量，再拉起 electron-builder。
 *
 * 为什么需要这层封装：
 * - electron-builder 首次运行会从 GitHub 下载 nsis / winCodeSign 等二进制（不是 npm 包），
 *   本机直连 GitHub 不通，必须走 npmmirror 镜像；
 * - 顺手清掉 ELECTRON_RUN_AS_NODE（本机 shell 会注入，带着它 electron 会退化成 node）。
 *
 * 用法：
 *   node scripts/dist.mjs            产出 NSIS 安装包 + 绿色便携版
 *   node scripts/dist.mjs --dir      只产出免安装目录（调试打包用，最快）
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const env = { ...process.env }

env['ELECTRON_BUILDER_BINARIES_MIRROR'] ??= 'https://npmmirror.com/mirrors/electron-builder-binaries/'
env['ELECTRON_MIRROR'] ??= 'https://npmmirror.com/mirrors/electron/'
delete env['ELECTRON_RUN_AS_NODE']

const cli = resolve('node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
if (!existsSync(cli)) {
  console.error('[dist] 没找到 electron-builder，先执行：npm i -D electron-builder')
  process.exit(1)
}

const args = [cli, '--win', ...process.argv.slice(2)]
console.log('[dist] electron-builder', args.slice(1).join(' '))

const result = spawnSync(process.execPath, args, { stdio: 'inherit', env })
process.exit(result.status ?? 1)
