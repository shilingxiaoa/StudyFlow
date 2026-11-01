/**
 * 造冒烟用的导入素材：一份 .md（带 frontmatter / 图片语法）、一份 .docx（真实 zip 结构）、一份 .pdf（用来验证被拒）。
 * 产物写在 .tmp-fixtures/（.gitignore 已忽略），由 npm run smoke 在启动 Electron 前调用。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '..', '.tmp-fixtures')
mkdirSync(dir, { recursive: true })

const markdown = `---
title: 被 frontmatter 包起来的内容不该出现
tags: [日语, N3]
---

# 第一章 五十音

日语假名分平假名与片假名，共九十二个基础音节。

![假名表格](./kana.png)

## 学习顺序

1. あ行 → か行 → さ行
2. 边写边读，每天两组
3. 用单词记忆，不孤立背假名
`

writeFileSync(join(dir, 'kana.md'), markdown, 'utf8')

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Word 段落一：第一段正文，讲学习方法。</w:t></w:r></w:p>
    <w:p><w:r><w:t>第二段：</w:t></w:r><w:r><w:t xml:space="preserve">包含 &amp; 特殊 &lt;符号&gt;。</w:t></w:r></w:p>
    <w:p/>
    <w:p><w:r><w:t>第三段：制表符</w:t></w:r><w:r><w:tab/><w:t>之后</w:t></w:r></w:p>
  </w:body>
</w:document>`

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`

const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

const zip = new JSZip()
zip.file('[Content_Types].xml', contentTypes)
zip.file('_rels/.rels', rels)
zip.file('word/document.xml', documentXml)
writeFileSync(join(dir, 'sample.docx'), await zip.generateAsync({ type: 'nodebuffer' }))

writeFileSync(join(dir, 'notes.pdf'), '%PDF-1.4\nnot really a pdf\n', 'utf8')

console.log(`[fixtures] ${dir}`)
