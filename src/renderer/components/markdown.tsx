/* ============================================================
   StudyFlow · 轻量 Markdown 渲染
   只覆盖 AI 文案里实际会用到的子集：标题 / 段落 / 列表 / 引用 /
   围栏代码块 / 行内强调。全部输出 React 节点，不拼 HTML 字符串，
   也不需要额外依赖（未知语法按普通段落输出）。
   ============================================================ */
import { useMemo } from 'react'
import type { JSX, ReactNode } from 'react'
import './markdown.css'

export interface MarkdownProps {
  /** 要渲染的 Markdown 文本 */
  text: string
  /** 追加到根节点上的类名（例如阅读宽度微调） */
  className?: string
}

interface MdListItem {
  text: string
  ordered: boolean
  children: MdListItem[]
}

type MdBlock =
  | { kind: 'heading'; level: 4 | 5; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; code: string }
  | { kind: 'list'; ordered: boolean; items: MdListItem[] }

const HEADING = /^(#{1,4})\s+(.+)$/
const BULLET = /^(\s*)[-*]\s+(.+)$/
const ORDERED = /^(\s*)\d+\.\s+(.+)$/
const QUOTE = /^\s*>\s?(.*)$/
const FENCE = /^\s*```\s*[A-Za-z0-9_+-]*\s*$/

function isBlockStart(line: string): boolean {
  return (
    HEADING.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    QUOTE.test(line) ||
    FENCE.test(line)
  )
}

/**
 * 行内语法：`代码`、**粗体**、[文字](http 链接)。
 * 非 http(s) 链接只保留文字，不生成可点击的 a 标签。
 */
function renderInline(text: string, prefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let buffer = ''
  let index = 0

  const flush = (): void => {
    if (buffer !== '') {
      nodes.push(buffer)
      buffer = ''
    }
  }

  while (index < text.length) {
    const char = text[index]

    if (char === '`') {
      const end = text.indexOf('`', index + 1)
      if (end > index + 1) {
        flush()
        nodes.push(<code key={`${prefix}-code-${nodes.length}`}>{text.slice(index + 1, end)}</code>)
        index = end + 1
        continue
      }
    }

    if (char === '*' && text[index + 1] === '*') {
      const end = text.indexOf('**', index + 2)
      if (end > index + 2) {
        flush()
        nodes.push(
          <strong key={`${prefix}-strong-${nodes.length}`}>
            {renderInline(text.slice(index + 2, end), `${prefix}-s${nodes.length}`)}
          </strong>
        )
        index = end + 2
        continue
      }
    }

    if (char === '[') {
      const labelEnd = text.indexOf(']', index + 1)
      if (labelEnd > index + 1 && text[labelEnd + 1] === '(') {
        const hrefEnd = text.indexOf(')', labelEnd + 2)
        if (hrefEnd > labelEnd + 2) {
          const label = text.slice(index + 1, labelEnd)
          const href = text.slice(labelEnd + 2, hrefEnd).trim()
          flush()
          if (/^https?:\/\//i.test(href)) {
            nodes.push(
              <a
                key={`${prefix}-link-${nodes.length}`}
                href={href}
                target="_blank"
                rel="noreferrer"
              >
                {renderInline(label, `${prefix}-l${nodes.length}`)}
              </a>
            )
          } else {
            nodes.push(<span key={`${prefix}-plain-${nodes.length}`}>{label}</span>)
          }
          index = hrefEnd + 1
          continue
        }
      }
    }

    buffer += char
    index += 1
  }

  flush()
  return nodes
}

/** 一个列表块 → 带一层嵌套的条目树（缩进 >= 2 视为子项） */
function parseListItems(lines: string[]): MdListItem[] {
  const items: MdListItem[] = []
  let lastTop: MdListItem | null = null

  for (const line of lines) {
    const orderedMatch = line.match(ORDERED)
    const bulletMatch = orderedMatch ? null : line.match(BULLET)
    const match = orderedMatch ?? bulletMatch
    if (!match) continue

    const indent = match[1].replace(/\t/g, '  ').length
    const item: MdListItem = { text: match[2].trim(), ordered: orderedMatch !== null, children: [] }

    if (indent >= 2 && lastTop) {
      lastTop.children.push(item)
    } else {
      items.push(item)
      lastTop = item
    }
  }

  return items
}

function parseBlocks(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MdBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (line.trim() === '') {
      index += 1
      continue
    }

    // ``` 围栏代码块：内容原样保留
    if (FENCE.test(line)) {
      index += 1
      const code: string[] = []
      while (index < lines.length && !FENCE.test(lines[index])) {
        code.push(lines[index])
        index += 1
      }
      index += 1 // 跳过结束围栏；没有结束围栏时越界即结束
      blocks.push({ kind: 'code', code: code.join('\n') })
      continue
    }

    // ### / #### → h4 / h5；更浅或更深的标题统一落在 h4 这一级
    const heading = line.match(HEADING)
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1].length >= 4 ? 5 : 4,
        text: heading[2].trim()
      })
      index += 1
      continue
    }

    if (QUOTE.test(line)) {
      const quoteLines: string[] = []
      while (index < lines.length) {
        const match = lines[index].match(QUOTE)
        if (!match) break
        quoteLines.push(match[1])
        index += 1
      }
      blocks.push({ kind: 'quote', text: quoteLines.join('\n') })
      continue
    }

    const listStart = line.match(ORDERED) ?? line.match(BULLET)
    if (listStart) {
      const listLines: string[] = []
      while (index < lines.length && (ORDERED.test(lines[index]) || BULLET.test(lines[index]))) {
        listLines.push(lines[index])
        index += 1
      }
      blocks.push({
        kind: 'list',
        ordered: ORDERED.test(line),
        items: parseListItems(listLines)
      })
      continue
    }

    // 其余连续非空行按一个段落处理（行内保留换行，由 CSS 决定如何展示）
    const paragraph: string[] = []
    while (index < lines.length) {
      const current = lines[index]
      if (current.trim() === '' || isBlockStart(current)) break
      paragraph.push(current.trim())
      index += 1
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
  }

  return blocks
}

function renderListItems(items: MdListItem[], prefix: string): JSX.Element[] {
  return items.map((item, index) => {
    const key = `${prefix}-${index}`
    const nested = item.children
    const nestedOrdered = nested.length > 0 && nested[0].ordered
    return (
      <li key={key}>
        {renderInline(item.text, key)}
        {nested.length > 0 ? (
          nestedOrdered ? (
            <ol className="sf-md__list sf-md__list--nested">
              {renderListItems(nested, `${key}-n`)}
            </ol>
          ) : (
            <ul className="sf-md__list sf-md__list--nested">
              {renderListItems(nested, `${key}-n`)}
            </ul>
          )
        ) : null}
      </li>
    )
  })
}

function renderBlocks(blocks: MdBlock[]): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `block-${index}`

    switch (block.kind) {
      case 'heading': {
        const Tag = block.level === 5 ? 'h5' : 'h4'
        return <Tag key={key}>{renderInline(block.text, key)}</Tag>
      }
      case 'paragraph':
        return <p key={key}>{renderInline(block.text, key)}</p>
      case 'quote':
        return <blockquote key={key}>{renderInline(block.text, key)}</blockquote>
      case 'code':
        return (
          <pre key={key} className="sf-md__pre">
            <code>{block.code}</code>
          </pre>
        )
      case 'list': {
        const Tag = block.ordered ? 'ol' : 'ul'
        return (
          <Tag key={key} className="sf-md__list">
            {renderListItems(block.items, key)}
          </Tag>
        )
      }
      default:
        return null
    }
  })
}

/**
 * Markdown 子集渲染器。空文本返回 null，方便直接放在卡片里。
 */
export function Markdown({ text, className }: MarkdownProps): JSX.Element | null {
  const blocks = useMemo(() => parseBlocks(text), [text])

  if (blocks.length === 0) return null

  return (
    <div className={className ? `sf-md ${className}` : 'sf-md'}>
      {renderBlocks(blocks)}
    </div>
  )
}

export default Markdown
