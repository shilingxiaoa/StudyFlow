/**
 * 造冒烟用的导入素材：.md（带 frontmatter / 图片语法）、.docx、.pptx（两页 + 备注）、.pdf（验证被拒）。
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

// ---- PowerPoint：两页幻灯片 + 第一页备注，用来验证 .pptx 解析 ----
const slide = (title, body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:rPr lang="zh-CN"/><a:t>${title}</a:t></a:r></a:p>
    <a:p><a:r><a:t>${body}</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`

const notes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
         xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>讲稿备注：先演示一遍 Agent 的最小闭环</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:notes>`

const pptxContentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`

const pptxRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`

const pptxPresentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
                xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId2" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></p:sldIdLst>
</p:presentation>`

const pptx = new JSZip()
pptx.file('[Content_Types].xml', pptxContentTypes)
pptx.file('_rels/.rels', pptxRels)
pptx.file('ppt/presentation.xml', pptxPresentation)
pptx.file('ppt/slides/slide1.xml', slide('课堂 PPT 第一页标题', '要点：什么是 Agent'))
// 故意让第 2 页排在文件列表前面也没关系，解析侧按页码排序
pptx.file('ppt/slides/slide2.xml', slide('第二页：工具调用', '练习：写一个最小的 function calling'))
pptx.file('ppt/notesSlides/notesSlide1.xml', notes)
writeFileSync(join(dir, 'lecture.pptx'), await pptx.generateAsync({ type: 'nodebuffer' }))

writeFileSync(join(dir, 'notes.pdf'), '%PDF-1.4\nnot really a pdf\n', 'utf8')

console.log(`[fixtures] ${dir}`)
