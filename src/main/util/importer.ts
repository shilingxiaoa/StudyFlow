/**
 * 学习资料导入：把本地文件读成纯文本，存进 material 表，供生成计划 / 出题时参考。
 *
 * 支持：.md / .markdown / .txt（直接读 UTF-8）、.docx（解 zip 取 word/document.xml）、
 *       .pptx（解 zip 取 ppt/slides/slideN.xml，逐页抽文字，带上备注）。
 * 不支持：.doc / .ppt（老二进制格式）、PDF、图片、网页。
 */
import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import JSZip from 'jszip'
import { AppError } from '../ipc/handle'

/** 单份文件上限：超过就拒绝（不是截断），避免把几 MB 的日志灌进 prompt */
export const MAX_FILE_BYTES = 8 * 1024 * 1024
/** 单次最多导入多少份 */
export const MAX_FILES = 20
/** 每份资料最多留多少字符进库（AI 侧还会再截取前 5000 字） */
export const MAX_TEXT_CHARS = 200_000

const TEXT_EXTS = new Set(['.md', '.markdown', '.txt'])
const DOCX_EXTS = new Set(['.docx'])
const PPTX_EXTS = new Set(['.pptx'])

export interface ParsedDocument {
  /** 文件名去掉扩展名，作为资料标题 */
  title: string
  content: string
  /** 导入的资料统一按「章节」看待，和手写资料区分开 */
  kind: 'chapter'
}

export function isSupportedDocument(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  return TEXT_EXTS.has(ext) || DOCX_EXTS.has(ext) || PPTX_EXTS.has(ext)
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/** 把 word/document.xml 转成纯文本：按段落切，取 <w:t>，处理换行与制表符 */
export function docxXmlToText(xml: string): string {
  const paragraphs = xml.split(/<\/w:p>/i)
  const lines: string[] = []
  for (const paragraph of paragraphs) {
    const pieces: string[] = []
    // 段落内除了 <w:t> 还可能有 <w:br/>（软换行）与 <w:tab/>（制表符）
    const tokenPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>/gi
    let match: RegExpExecArray | null
    while ((match = tokenPattern.exec(paragraph)) !== null) {
      const token = match[0]
      if (match[1] !== undefined) pieces.push(decodeXmlEntities(match[1]))
      else if (/^<w:tab/i.test(token)) pieces.push('\t')
      else pieces.push('\n')
    }
    const line = pieces.join('').replace(/[ \t]+$/g, '')
    if (line.trim() !== '') lines.push(line)
  }
  return lines.join('\n')
}

/** 把单张幻灯片 XML 转成文本：每个 <a:p> 一段，段内拼 <a:t>，<a:br/> 当换行 */
export function slideXmlToText(xml: string): string {
  const paragraphs = xml.split(/<\/a:p>/i)
  const lines: string[] = []
  for (const paragraph of paragraphs) {
    const pieces: string[] = []
    const tokenPattern = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\s*\/>/gi
    let match: RegExpExecArray | null
    while ((match = tokenPattern.exec(paragraph)) !== null) {
      if (match[1] !== undefined) pieces.push(decodeXmlEntities(match[1]))
      else pieces.push('\n')
    }
    const line = pieces.join('').replace(/[ \t]+$/g, '')
    if (line.trim() !== '') lines.push(line)
  }
  return lines.join('\n')
}

/** Markdown → 纯文本：去掉 YAML frontmatter、图片语法与行尾空白，压缩空行 */
export function markdownToText(raw: string): string {
  let text = raw.replace(/\r\n?/g, '\n')
  text = text.replace(/^\uFEFF/, '')
  // 文件开头的 --- 元信息块
  text = text.replace(/^---\n[\s\S]*?\n---\n/, '')
  // 图片：保留 alt 文本，去掉路径
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 行内 HTML 标签（<br>、<div> 之类）直接去掉标签本身
  text = text.replace(/<\/?[a-zA-Z][^>\n]{0,80}>/g, '')
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

function truncate(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text
  return `${text.slice(0, MAX_TEXT_CHARS)}\n\n（内容过长，已截断到 ${MAX_TEXT_CHARS} 字）`
}

/**
 * 解 .pptx 的 zip：找 ppt/slides/slideN.xml（按页码排序），逐页抽文字，
 * 有备注页（ppt/notesSlides/notesSlideN.xml）就一起带上 —— 讲稿往往比幻灯片本身更有信息。
 */
export async function pptxToText(buffer: Buffer, fileName: string): Promise<string> {
  const zip = await JSZip.loadAsync(buffer)

  const slides = Object.keys(zip.files)
    .map((name) => {
      const matched = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(name)
      return matched ? { name, index: Number(matched[1]) } : null
    })
    .filter((item): item is { name: string; index: number } => item !== null)
    .sort((a, b) => a.index - b.index)

  if (slides.length === 0) {
    throw new AppError('VALIDATION', `${fileName} 里没有找到幻灯片（可能不是 PowerPoint 文件）`)
  }

  const pages: string[] = []
  for (const slide of slides) {
    const entry = zip.file(slide.name)
    if (!entry) continue
    const text = slideXmlToText(await entry.async('string'))

    const notesEntry = zip.file(`ppt/notesSlides/notesSlide${slide.index}.xml`)
    const notes = notesEntry ? slideXmlToText(await notesEntry.async('string')) : ''

    if (text.trim() === '' && notes.trim() === '') continue
    const notesBlock = notes.trim() === '' ? '' : `\n\n【备注】\n${notes}`
    pages.push(`## 第 ${slide.index} 页\n${text}${notesBlock}`)
  }

  return pages.join('\n\n')
}

/** 读一个文件并解析成资料内容；失败抛 AppError（带可读中文原因） */
export async function parseDocument(filePath: string): Promise<ParsedDocument> {
  const title = basename(filePath, extname(filePath)).trim() || '未命名资料'
  const ext = extname(filePath).toLowerCase()

  if (!isSupportedDocument(filePath)) {
    throw new AppError(
      'VALIDATION',
      `不支持 ${ext || '这种'} 格式，只能导入 .md / .markdown / .txt / .docx / .pptx`
    )
  }

  let size = 0
  try {
    size = statSync(filePath).size
  } catch {
    throw new AppError('NOT_FOUND', `读不到文件：${basename(filePath)}`)
  }
  if (size > MAX_FILE_BYTES) {
    throw new AppError(
      'VALIDATION',
      `${basename(filePath)} 有 ${Math.round(size / 1024 / 1024)}MB，超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限`
    )
  }

  let buffer: Buffer
  try {
    buffer = readFileSync(filePath)
  } catch {
    throw new AppError('NOT_FOUND', `读不到文件：${basename(filePath)}`)
  }

  if (DOCX_EXTS.has(ext)) {
    const zip = await JSZip.loadAsync(buffer)
    const entry = zip.file('word/document.xml')
    if (!entry) {
      throw new AppError('VALIDATION', `${basename(filePath)} 里没有找到正文（可能不是 Word 文档）`)
    }
    const xml = await entry.async('string')
    const content = truncate(docxXmlToText(xml))
    if (content.trim() === '') {
      throw new AppError('VALIDATION', `${basename(filePath)} 里没有可读文字（可能是纯图片文档）`)
    }
    return { title, content, kind: 'chapter' }
  }

  if (PPTX_EXTS.has(ext)) {
    const content = truncate(await pptxToText(buffer, basename(filePath)))
    if (content.trim() === '') {
      throw new AppError('VALIDATION', `${basename(filePath)} 里没有可读文字（可能整份都是图片）`)
    }
    return { title, content, kind: 'chapter' }
  }

  const text = buffer.toString('utf8')
  const content = truncate(ext === '.txt' ? text.replace(/\r\n?/g, '\n').trim() : markdownToText(text))
  if (content.trim() === '') {
    throw new AppError('VALIDATION', `${basename(filePath)} 是空文件`)
  }
  return { title, content, kind: 'chapter' }
}
