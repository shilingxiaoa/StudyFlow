// DeepSeek 的 strict json_schema 只接受单值 type，联合类型（type: ['array','null'] 等）会直接 400。
// 这里做静态扫描，防止以后又写回去。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const FILES = ['src/main/ai/schemas.ts']
const PATTERN = /type:\s*\[[^\]]*\]/g
let bad = 0

for (const file of FILES) {
  const text = readFileSync(resolve(process.cwd(), file), 'utf8')
  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    const code = line.replace(/\/\/.*$/, '')
    const hit = code.match(PATTERN)
    if (!hit) return
    bad += 1
    console.error(`[schema-lint] ${file}:${index + 1} 出现联合类型 —— ${line.trim()}`)
  })
}

if (bad > 0) {
  console.error(`[schema-lint] 失败：${bad} 处联合类型。DeepSeek strict json_schema 不支持，请改成单值 type。`)
  process.exit(1)
}
console.log('[schema-lint] 通过：没有联合类型')
