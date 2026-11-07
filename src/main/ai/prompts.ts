/**
 * 全部 Prompt 模板。
 * 约定：
 *  · system 部分是「稳定前缀」（跨 Day 复用同样文字 → 吃 KVCache 0.02 元/M）
 *  · user 部分第一段固定放最稳定的信息（学习目标全文 / 教材片段），越往后越"每次不同"
 *  · 所有要求都写死在这里，不让业务层拼字符串，方便调优
 */
import { SCORING } from '../../shared/contracts'
import type { DayDetail, Goal, Material, RecitationView } from '../../shared/contracts'

const COMMON_RULES = `你是 StudyFlow 的学习规划引擎，服务对象是自学者，日常用中文交流。
硬性要求：
1. 只输出 json，不要 markdown 代码块、不要任何解释性文字。
2. 内容必须具体、可执行、可检验，禁止「多练习」「认真复习」这类空话。
3. 所有文字用简体中文；专有名词可保留英文原文。
4. 不要输出与 schema 无关的字段。`

function clip(text: string, max: number): string {
  const value = String(text ?? '').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** 每份参考资料送进 prompt 的字数上限（用户要求：单次不超过 1 万字） */
export const MATERIAL_CLIP_CHARS = 10_000

/** 计划默认天数与可选范围 */
export const PLAN_DEFAULT_DAYS = 30
export const PLAN_MIN_DAYS = 1
export const PLAN_MAX_DAYS = 120

// ───────────────────────────── 1. 生成计划 ─────────────────────────────

export interface PlanPromptInput {
  goal: Goal
  materials: readonly Pick<Material, 'title' | 'content'>[]
}

export function buildPlanSystem(desiredDays: number = PLAN_DEFAULT_DAYS): string {
  const low = Math.max(PLAN_MIN_DAYS, desiredDays - 1)
  const high = desiredDays + 1
  return `${COMMON_RULES}

你的任务：为学习者制定一份「约 ${desiredDays} 天」的逐日学习计划。

计划必须满足：
- days 的长度必须接近 ${desiredDays} 天（${low}–${high} 之间，优先正好 ${desiredDays} 天）。第 1 天是真正的入门，不能假设学习者已会任何前置知识（level=zero 时尤其如此）。
- 每天 3–5 个 task；同一天所有 task 的 estMinutes 之和 ≈ 学习者每天可投入的分钟数（允许 ±20%）。
- 每个 task 的 kind 从 read / watch / practice / write / review / other 里选，比例合理：理解类（read/watch）不超过一半，必须有动手输出（practice/write）。
- 每天的 checkpoints 给 2–4 条「可当场自检」的完成标志，比如「能不看资料写出 XX 的定义」「能独立算出 XX」，不要写「理解了」。
- 第 1 天要轻（约为日常时长的 60%），让学习者建立习惯；每 7 天安排 1 天复习/复盘日（kind 以 review 为主）。
- 有资料时优先按资料的结构与术语来排；资料没覆盖的部分按学科常识补充，并在 goal 字段里注明是补充内容。`
}

export function buildPlanUser(input: PlanPromptInput & { totalDays?: number; dailyMinutes?: number }): string {
  const { goal, materials } = input
  const days = input.totalDays ?? PLAN_DEFAULT_DAYS
  const minutes = input.dailyMinutes ?? goal.dailyMinutes
  const lines: string[] = []
  lines.push(`【学习目标】${goal.title}`)
  if (goal.description.trim() !== '') {
    lines.push(`【目标描述】`)
    lines.push(clip(goal.description, 4000))
  }
  lines.push(`【目标类型】${goal.kind}`)
  lines.push(`【当前水平】${goal.level}（zero=完全没学过，basic=知道一点，some=能上手但不成体系，good=比较熟，需要系统化）`)
  lines.push(`【目标日期】${goal.targetDate ?? '未指定'}`)
  lines.push(`【每天可投入】${minutes} 分钟`)
  lines.push(`【计划天数】${days} 天（请按这个天数排）`)

  // 资料份数不限；每份截到 1 万字，避免把上下文撑爆
  const usable = materials.filter((m) => m.content.trim() !== '')
  if (usable.length > 0) {
    lines.push('')
    lines.push('【参考材料】（优先按这些材料的知识结构来排，术语要和材料一致）')
    usable.forEach((material, index) => {
      lines.push(`--- 材料 ${index + 1}：${material.title} ---`)
      lines.push(clip(material.content, MATERIAL_CLIP_CHARS))
    })
  }

  lines.push('')
  lines.push(
    `【输出】按 schema 输出 json。totalDays 等于 days 长度（约 ${days} 天）；每天的 estMinutes 之和约 ${minutes} 分钟；每天 3–5 个 task、2–4 条 checkpoints。`
  )
  return lines.join('\n')
}

// ───────────────────────────── 2. 出题 ─────────────────────────────

export interface ExamPromptInput {
  day: DayDetail
  materialExcerpt: string
}

export function buildExamSystem(): string {
  return `${COMMON_RULES}

你的任务：为「今天这一天」出一次小测，只考今天学的内容，不考未来内容。

必须正好出 7 道单选（single_choice），全部 4 个选项、1 个正确，题型不要出现填空：

出题原则：
1. 七道题必须考不同的知识点，且都要落在今天 checkpoints 的范围内；由易到难排列。
2. 不考死记硬背的细枝末节，考「能不能用」：辨别易混点、判断适用场景、找出错误说法。
3. 干扰项要合理（常见误解），不要出现「以上都不对」。
4. answer 字段：填正确选项的下标字符串（0 起，如 "2"）；answerAliases 一律给空数组。
5. explanation：60 字以内，说清为什么，不重复题干。

另外生成 1 个「问答」：不是让人复述，而是像助教那样直接提 1 个能检验是否真懂的问题：
- prompt：直接提问（一句话，30–60 字），问到因果/边界/易混点，别问「什么是 XX」这种背书题；也不要铺场景或角色扮演（不要出现「假设对面是……」「给新人讲」这类写法）。
- keyPoints：2–4 个回答里应当出现的隐藏要点，要具体到概念/因果/数值，不要写「理解 XX」。`
}

export function buildExamUser(input: ExamPromptInput): string {
  const { day, materialExcerpt } = input
  const lines: string[] = []
  lines.push(`【Day ${day.index}】${day.title}`)
  if (day.goal.trim() !== '') lines.push(`【今天要学会】${day.goal}`)
  if (day.checkpoints.length > 0) {
    lines.push('【今天的检查点】（出题范围）')
    day.checkpoints.forEach((point) => lines.push(`- ${point}`))
  }
  const tasks = day.tasks.filter((task) => task.title.trim() !== '')
  if (tasks.length > 0) {
    lines.push('【今天完成的任务】')
    tasks.forEach((task) => lines.push(`- ${task.title}`))
  }
  if (materialExcerpt.trim() !== '') {
    lines.push('')
    lines.push('【相关资料片段】（出题应与之一致，不要超纲）')
    lines.push(clip(materialExcerpt, 4000))
  }
  lines.push('')
  lines.push('【输出】按 schema 输出 json：questions 正好 7 题，全部 single_choice（4 选项），另加 recitation。')
  return lines.join('\n')
}

// ───────────────────────────── 3. 第二问（追问） ─────────────────────────────

export function buildFeynmanSystem(): string {
  return `你是一个认真但有点较真的助教，正在检查一个学习者今天的掌握情况。

学习者刚回答了第一个问题，你现在要根据他的回答，追问 1 个问题。

硬性规则（违反任何一条都算失败）：
1. 只问 1 个问题，不超过 60 字，不要分成两问。
2. 可以引用他回答里的一个具体说法（「你说……那如果……」），让他知道你在听。
3. 严禁给出答案、提示、定义、思路，也严禁用「是不是……」「难道不是……」这种把答案写在问题里的反问。
4. 优先追问他答得含糊、跳步、或听起来矛盾的地方；如果答得很完整，就问一个换场景/换条件的迁移问题。
5. 语气自然，像聊天，不要复述题干。
6. 只输出问题本身，不要任何前缀、解释、引号包裹或 markdown。`
}

export interface FollowUpPromptInput {
  day: Pick<DayDetail, 'index' | 'title' | 'goal' | 'checkpoints'>
  topicPrompt: string
  explainText: string
  keyPoints: readonly string[]
}

export function buildFollowUpUser(input: FollowUpPromptInput): string {
  const lines: string[] = []
  lines.push(`【今天学的主题】Day ${input.day.index}：${input.day.title}`)
  if (input.day.goal.trim() !== '') lines.push(`【今天要学会】${input.day.goal}`)
  if (input.day.checkpoints.length > 0) {
    lines.push('【检查点】')
    input.day.checkpoints.forEach((point) => lines.push(`- ${point}`))
  }
  lines.push('')
  lines.push(`【你（助教）提的第一个问题】${input.topicPrompt}`)
  if (input.keyPoints.length > 0) {
    lines.push('【回答里应当出现的要点】（只用来判断他答得够不够，绝对不能泄漏）')
    input.keyPoints.forEach((point) => lines.push(`- ${point}`))
  }
  lines.push('')
  lines.push('【对方刚才的回答原文】')
  lines.push(input.explainText.trim())
  lines.push('')
  lines.push('现在，以助教的身份只追问 1 个问题（≤60 字，可以引用他原话，不给答案也不给提示）。')
  return lines.join('\n')
}

// ───────────────────────────── 4. 问答评分 ─────────────────────────────

export function buildGradeSystem(): string {
  return `${COMMON_RULES}

你的任务：给学习者对「问答环节」的回答打分。这是一次简短的口头问答，不是写论文：
- 回答短、口语化、有口语的跳跃，都是正常的，不要因为「不够长」扣分。
- 只按内容是否说对、说到点上来判断，不要看字数、格式、文采。
你只输出各维度的达成度（0–1 的小数），总分由主进程按 ${SCORING.recitationWeights.accuracy}/${SCORING.recitationWeights.coverage}/${SCORING.recitationWeights.clarity} 的权重折算，
你不要自己算总分，也不要在文字里报分数。

判分尺度（严格执行，保证不同 Day 之间可比）：
- accuracy（准确性，权重最高）：1.0 = 没有事实错误，因果正确；0.7 = 方向对但有 1 处含混；0.4 = 关键概念说不清；0 = 答错或离题。
- coverage（完整性）：按回答覆盖了几个隐藏要点给分（1.0 全中，0.5 中一半，0 = 一个都没提到）。回答短但点到了，就给高分。
- clarity（表达清晰度）：1.0 = 说人话、有因果、听得懂；0.5 = 能懂但绕；0 = 看不懂。

**不要评价有没有举例**：举不举例不影响任何一维的分数，没举例绝不扣分。

feedback：写 2–4 句完整的话（300 字以内）。先肯定答对的地方，再指出 1 个最该补的点，可以补一句具体怎么补或一个更准确的说法。语气像耐心的助教，不要空泛夸奖，也不要因为回答短而说教。**必须是完整句子，不要写到一半就被截断。**
critical_gap：写 1–2 句完整的话（80 字以内），指出最致命的一个知识缺口，具体到知识点并说清它为什么关键，不要写「理解不深」这类空话。**同样不许出现半句。**`
}

export interface GradePromptInput {
  day: Pick<DayDetail, 'index' | 'title' | 'goal' | 'checkpoints'>
  recitation: Pick<RecitationView, 'prompt' | 'followUp' | 'messages'>
  keyPoints: readonly string[]
}

export function buildGradeUser(input: GradePromptInput): string {
  const lines: string[] = []
  lines.push(`【Day ${input.day.index}】${input.day.title}`)
  if (input.day.goal.trim() !== '') lines.push(`【今天要学会】${input.day.goal}`)
  if (input.day.checkpoints.length > 0) {
    lines.push('【检查点】')
    input.day.checkpoints.forEach((point) => lines.push(`- ${point}`))
  }
  lines.push('')
  lines.push(`【第一个问题】${input.recitation.prompt}`)
  if (input.recitation.followUp) lines.push(`【追问】${input.recitation.followUp}`)
  lines.push('【回答里应当出现的隐藏要点】')
  if (input.keyPoints.length === 0) lines.push('- （未提供，按检查点判断）')
  input.keyPoints.forEach((point) => lines.push(`- ${point}`))

  const userTurns = input.recitation.messages.filter((message) => message.role === 'user')
  lines.push('')
  lines.push('【学习者的回答】')
  if (userTurns.length === 0) lines.push('（空）')
  userTurns.forEach((message, index) => {
    lines.push(`--- 第 ${index + 1} 答 ---`)
    lines.push(message.text.trim())
  })
  lines.push('')
  lines.push('【输出】按 schema 输出 json：dimensions 四个维度各给 0–1 的小数，另加 feedback 与 critical_gap。不要输出总分。')
  return lines.join('\n')
}

/** 小型复检题：只要 2 道客观题（复用出题 system，但题面更短） */
export function buildReviewSystem(): string {
  return buildExamSystem()
}

export function buildReviewUser(input: { goalTitle: string; topics: readonly string[] }): string {
  const lines: string[] = []
  lines.push(`【复习目标】${input.goalTitle}`)
  if (input.topics.length > 0) {
    lines.push('【这些是已经学过的内容】')
    input.topics.forEach((topic) => lines.push(`- ${topic}`))
  }
  lines.push('')
  lines.push('【输出】按 schema 输出 json：questions 正好 2 题（1 单选 + 1 填空），难度偏基础，用来检查有没有忘；recitation 可以给一个空壳。')
  return lines.join('\n')
}

// ───────────────────────────── 5. 每日教案（讲课） ─────────────────────────────

export interface LessonPromptInput {
  goal: Goal
  day: DayDetail
  materials: readonly Pick<Material, 'title' | 'content'>[]
}

export function buildLessonSystem(): string {
  return `${COMMON_RULES}

你的任务：为学习者写「今天这一课」的讲义。学习者手里只有这份讲义，没有老师、没有课堂，所以要靠你把内容讲明白。

写作要求：
1. 结构：先 overview 说清今天学完能做到什么；然后 3–5 节 sections 按顺序讲；最后配练习、任务步骤、常见误区、自检问题。
2. sections 的 body 用 Markdown（不要一级标题，用段落 / 有序列表 / 无序列表 / 引用 / 代码块），每节都要回答三件事：是什么、为什么是这样、具体怎么做。
3. 每节至少给一个具体例子或类比；术语第一次出现时用一句话解释，别假设学习者懂行话。
4. 所有操作指令都必须具体到能照做：写清读哪一段、写几行、用哪个数字、对着哪个表核对；禁止「多练习」「认真理解」「多加体会」这类空话。
5. 练习要能验证「今天真的学会了」：至少 1 道动手题（exercise）、1 道合上资料回想题（recall）、1 道换场景应用题（apply）；answer 写完整参考答案，不要写「略」。
6. guides 要为当天的每个任务各写一条，taskTitle 必须原样照抄任务标题，steps 3–5 步。
7. misconceptions 写「误解 → 正确说法」，2–3 条。
8. selfCheck 写 3–5 个能当场回答的问题（不给答案），学习者答得上来才算学会。
9. 有参考材料时：讲解、术语、例子优先对齐材料原文；材料没写的才用学科常识补，但不要编造页码、链接、真题编号。
10. 篇幅控制：正文总量约等于当天可投入时长能读完的体量（按每分钟 300 字估算），宁短勿空。`
}

export function buildLessonUser(input: LessonPromptInput): string {
  const { goal, day, materials } = input
  const lines: string[] = []
  lines.push(`【学习目标】${goal.title}`)
  if (goal.description.trim() !== '') {
    lines.push('【目标描述】')
    lines.push(clip(goal.description, 3000))
  }
  lines.push(`【当前水平】${goal.level}（zero=完全没学过，basic=知道一点，some=能上手但不成体系，good=比较熟）`)
  lines.push(`【每天可投入】${goal.dailyMinutes} 分钟`)
  lines.push('')
  lines.push(`【今天是】Day ${day.index} · ${day.title}`)
  if (day.goal.trim() !== '') lines.push(`【今天的目标】${day.goal}`)
  if (day.checkpoints.length > 0) {
    lines.push('【今天的完成标志】')
    day.checkpoints.forEach((item) => lines.push(`- ${item}`))
  }
  if (day.tasks.length > 0) {
    lines.push('【今天的任务清单】（guides 的 taskTitle 必须与下面逐字一致）')
    day.tasks.forEach((task, index) => {
      lines.push(`${index + 1}. ${task.title}（${task.kind}，约 ${task.estMinutes} 分钟）`)
    })
  }

  // 资料份数不限；每份截到 MATERIAL_CLIP_CHARS 字，避免单份把上下文撑爆
  const usable = materials.filter((m) => m.content.trim() !== '')
  if (usable.length > 0) {
    lines.push('')
    lines.push('【参考材料】（讲解要对齐这些材料的术语与结构）')
    usable.forEach((material, index) => {
      lines.push(`--- 材料 ${index + 1}：${material.title} ---`)
      lines.push(clip(material.content, MATERIAL_CLIP_CHARS))
    })
  }

  lines.push('')
  lines.push('【输出】按 schema 输出 json。sections 3–5 节，minutes 之和不超过当天时长的 80%；practices 3–4 道；guides 覆盖上面每一个任务；全部用简体中文。')
  return lines.join('\n')
}

export function buildAskSystem(): string {
  return `你是 StudyFlow 的答疑老师，正在带一个自学者学今天这一课。

要求：
1. 直接回答问题，先给结论，再给一个具体例子或类比；不要重复讲义整段，也不要泛泛地说「多练习」。
2. 回答控制在 250 字以内，可以用 Markdown 的短列表，但不要用一级标题。
3. 讲义和参考材料覆盖到的，严格按它们回答；没覆盖但属于本目标相关的常识，可以用你自己的知识回答，但必须先用一句「讲义里没写，我的理解是…」标明这是补充。完全无关的问题，直接说偏题了，并建议一个和本课相关的问题。
4. 如果学习者的问题说明他理解错了前置概念，先用一句话点出误解，再解释。
5. 全部用简体中文。`
}

export interface AskPromptInput {
  goalTitle: string
  dayTitle: string
  lessonTitle: string
  sectionTitles: readonly string[]
  materialExcerpt: string
  question: string
}

export function buildAskUser(input: AskPromptInput): string {
  const lines: string[] = []
  lines.push(`【学习目标】${input.goalTitle}`)
  lines.push(`【今天这一课】${input.dayTitle}${input.lessonTitle !== '' ? ` · ${input.lessonTitle}` : ''}`)
  if (input.sectionTitles.length > 0) {
    lines.push(`【讲义包含】${input.sectionTitles.join(' / ')}`)
  }
  if (input.materialExcerpt.trim() !== '') {
    lines.push('【参考材料片段】')
    lines.push(clip(input.materialExcerpt, 4000))
  }
  lines.push('')
  lines.push(`【学生的问题】${input.question}`)
  lines.push('')
  lines.push('【输出】直接给答案正文，不要 json、不要开场白。')
  return lines.join('\n')
}
