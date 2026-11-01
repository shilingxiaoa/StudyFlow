/**
 * AI 输出结构的两套描述：
 *  · *JSON_SCHEMA —— 给 Responses API 的 strict json_schema（约束模型一定按形状输出）
 *  · *AiZ         —— 给 zod 兜底校验（同一个形状再验一遍，防模型钻空子/字段缺失）
 */
import { z } from 'zod'

// ───────────────────────────── 计划 ─────────────────────────────

export const TASK_KIND_VALUES = ['read', 'watch', 'practice', 'write', 'review', 'other'] as const

export const planTaskAiZ = z.object({
  title: z.string().default(''),
  kind: z.enum(TASK_KIND_VALUES).default('other'),
  estMinutes: z.number().default(15)
})

export const planDayAiZ = z.object({
  index: z.number().default(0),
  title: z.string().default(''),
  goal: z.string().default(''),
  estMinutes: z.number().default(60),
  checkpoints: z.array(z.string()).default([]),
  tasks: z.array(planTaskAiZ).default([])
})

export const planAiZ = z.object({
  title: z.string().default('学习计划'),
  summary: z.string().default(''),
  totalDays: z.number().default(0),
  days: z.array(planDayAiZ).default([])
})

export type PlanAi = z.infer<typeof planAiZ>
export type PlanDayAi = z.infer<typeof planDayAiZ>

export const PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'totalDays', 'days'],
  properties: {
    title: { type: 'string', description: '计划标题，20 字以内' },
    summary: { type: 'string', description: '计划思路，80 字以内' },
    totalDays: { type: 'integer', description: '总天数，等于 days 的长度' },
    days: {
      type: 'array',
      description: '逐日安排，约 30 天',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'title', 'goal', 'estMinutes', 'checkpoints', 'tasks'],
        properties: {
          index: { type: 'integer', description: '第几天，从 1 开始' },
          title: { type: 'string', description: '当天标题，20 字以内' },
          goal: { type: 'string', description: '当天要学会什么，一句话' },
          estMinutes: { type: 'integer', description: '当天预计总分钟数' },
          checkpoints: {
            type: 'array',
            description: '2-4 条可检验的完成标志',
            items: { type: 'string' }
          },
          tasks: {
            type: 'array',
            description: '3-5 个具体任务',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'kind', 'estMinutes'],
              properties: {
                title: { type: 'string', description: '任务标题，25 字以内' },
                kind: { type: 'string', enum: [...TASK_KIND_VALUES] },
                estMinutes: { type: 'integer' }
              }
            }
          }
        }
      }
    }
  }
}

// ───────────────────────────── 出题 ─────────────────────────────

export const questionAiZ = z.object({
  type: z.enum(['single_choice', 'fill_blank']).default('single_choice'),
  knowledgePoint: z.string().default(''),
  stem: z.string().default(''),
  options: z.array(z.string()).nullable().optional(),
  answer: z.union([z.string(), z.number()]).default(''),
  answerAliases: z.array(z.string()).default([]),
  explanation: z.string().default('')
})

export const examAiZ = z.object({
  questions: z.array(questionAiZ).default([]),
  recitation: z
    .object({
      prompt: z.string().default(''),
      keyPoints: z.array(z.string()).default([])
    })
    .default({ prompt: '', keyPoints: [] })
})

export type ExamAi = z.infer<typeof examAiZ>
export type QuestionAi = z.infer<typeof questionAiZ>

export const EXAM_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['questions', 'recitation'],
  properties: {
    questions: {
      type: 'array',
      description: '必须正好 2 题：1 道 single_choice + 1 道 fill_blank',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'type',
          'knowledgePoint',
          'stem',
          'options',
          'answer',
          'answerAliases',
          'explanation'
        ],
        properties: {
          type: { type: 'string', enum: ['single_choice', 'fill_blank'] },
          knowledgePoint: { type: 'string', description: '考查的知识点名称' },
          stem: { type: 'string', description: '题干' },
          options: {
            // DeepSeek 的 strict json_schema 不接受联合类型（`type: ['array','null']` 直接 400），
            // 填空题给空数组，题型由 examiner 的 normalizeExam 再判定。
            type: 'array',
            description: 'single_choice 必须 4 个选项；fill_blank 给空数组',
            items: { type: 'string' }
          },
          answer: {
            type: 'string',
            description: 'single_choice 填正确选项下标（0 起，如 "2"）；fill_blank 填标准答案原文'
          },
          answerAliases: {
            type: 'array',
            description: '填空题的等价写法（含别名/简称/英文），2-4 个；单选题给空数组',
            items: { type: 'string' }
          },
          explanation: { type: 'string', description: '解析，60 字以内' }
        }
      }
    },
    recitation: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt', 'keyPoints'],
      properties: {
        prompt: {
          type: 'string',
          description: '让学生讲给一个「完全没学过的人」听的场景题面，一句话'
        },
        keyPoints: {
          type: 'array',
          description: '2-4 个必须讲到的隐藏要点（不给学生看）',
          items: { type: 'string' }
        }
      }
    }
  }
}

// ───────────────────────────── 问答评分 ─────────────────────────────

export const gradeAiZ = z.object({
  dimensions: z
    .object({
      accuracy: z.number().default(0),
      coverage: z.number().default(0),
      example: z.number().default(0),
      clarity: z.number().default(0)
    })
    .default({ accuracy: 0, coverage: 0, example: 0, clarity: 0 }),
  feedback: z.string().default(''),
  critical_gap: z.string().default('')
})

export type GradeAi = z.infer<typeof gradeAiZ>

/** 只让模型给 0-1 达成度，分数由主进程按契约权重折算 */
export const GRADE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['dimensions', 'feedback', 'critical_gap'],
  properties: {
    dimensions: {
      type: 'object',
      additionalProperties: false,
      required: ['accuracy', 'coverage', 'example', 'clarity'],
      properties: {
        accuracy: { type: 'number', description: '准确性达成度 0-1' },
        coverage: { type: 'number', description: '要点覆盖度 0-1' },
        example: { type: 'number', description: '例子/类比的支撑度 0-1' },
        clarity: { type: 'number', description: '讲解清晰度 0-1' }
      }
    },
    feedback: {
      type: 'string',
      description: '总评，2–4 句完整的话，300 字以内，不要写到一半'
    },
    critical_gap: {
      type: 'string',
      description: '最致命的一个知识缺口，1–2 句完整的话，80 字以内，不要写到一半'
    }
  }
}

// ───────────────────────────── 统一包装 ─────────────────────────────

/** zod 校验失败的专用错误：client 会把它翻译成 AppError('AI_BAD_OUTPUT') */
export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchemaValidationError'
  }
}

/**
 * 一个 schema 描述：JSON Schema 交给 Responses API 做 strict 约束，
 * zod 这边再解析一次兜底（模型偶尔会漏字段/加字段）。
 */
export interface StructuredOutputSchema<T> {
  name: string
  schema: Record<string, unknown>
  parse(raw: string): T
}

function stripCodeFence(input: string): string {
  const text = input.trim()
  if (!text.startsWith('```')) return text
  return text
    .replace(/^```(?:json|JSON)?\s*/, '')
    .replace(/\s*```$/, '')
    .trim()
}

export function defineSchema<T>(
  name: string,
  jsonSchema: Record<string, unknown>,
  zodSchema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: unknown } }
): StructuredOutputSchema<T> {
  return {
    name,
    schema: jsonSchema,
    parse(raw: string): T {
      const cleaned = stripCodeFence(raw)
      let value: unknown
      try {
        value = JSON.parse(cleaned)
      } catch {
        throw new SchemaValidationError('AI 返回的不是合法 json')
      }
      const result = zodSchema.safeParse(value)
      if (!result.success) {
        throw new SchemaValidationError('AI 返回的字段不完整或类型不对')
      }
      return result.data
    }
  }
}

export const PLAN_SCHEMA = defineSchema<PlanAi>('studyflow_plan', PLAN_JSON_SCHEMA, planAiZ)
export const EXAM_SCHEMA = defineSchema<ExamAi>('studyflow_exam', EXAM_JSON_SCHEMA, examAiZ)
export const GRADE_SCHEMA = defineSchema<GradeAi>('studyflow_grade', GRADE_JSON_SCHEMA, gradeAiZ)

// ───────────────────────────── 每日教案 ─────────────────────────────

export const PRACTICE_KIND_VALUES = ['exercise', 'recall', 'apply'] as const

export const lessonSectionAiZ = z.object({
  title: z.string().default(''),
  minutes: z.number().default(10),
  body: z.string().default('')
})

export const lessonPracticeAiZ = z.object({
  kind: z.enum(PRACTICE_KIND_VALUES).default('exercise'),
  prompt: z.string().default(''),
  answer: z.string().default(''),
  hint: z.string().default('')
})

export const lessonGuideAiZ = z.object({
  taskTitle: z.string().default(''),
  steps: z.array(z.string()).default([])
})

export const lessonAiZ = z.object({
  title: z.string().default(''),
  overview: z.string().default(''),
  sections: z.array(lessonSectionAiZ).default([]),
  practices: z.array(lessonPracticeAiZ).default([]),
  guides: z.array(lessonGuideAiZ).default([]),
  misconceptions: z.array(z.string()).default([]),
  selfCheck: z.array(z.string()).default([])
})

export type LessonAi = z.infer<typeof lessonAiZ>

// 注意：strict json_schema 不接受联合类型，所有字段都必须是单值 type
export const LESSON_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'overview', 'sections', 'practices', 'guides', 'misconceptions', 'selfCheck'],
  properties: {
    title: { type: 'string', description: '这一课的标题，20 字以内，具体到知识点' },
    overview: { type: 'string', description: '学完这一节能做到什么，60 字以内，用可检验的说法' },
    sections: {
      type: 'array',
      description: '3–5 节讲解，按学习顺序排',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'minutes', 'body'],
        properties: {
          title: { type: 'string', description: '小节标题，12 字以内' },
          minutes: { type: 'integer', description: '建议用时（分钟）' },
          body: {
            type: 'string',
            description:
              'Markdown 正文，不含一级标题：讲清是什么/为什么/怎么做，必须带至少一个具体例子或类比；每段 2–4 句'
          }
        }
      }
    },
    practices: {
      type: 'array',
      description: '3–4 道练习，做完能验证今天学会了',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'prompt', 'answer', 'hint'],
        properties: {
          kind: { type: 'string', enum: ['exercise', 'recall', 'apply'], description: 'exercise=动手做，recall=合上资料回想，apply=换场景用' },
          prompt: { type: 'string', description: '题目/任务描述，具体到做什么' },
          answer: { type: 'string', description: '完整参考答案（不是「略」）' },
          hint: { type: 'string', description: '卡住时可以看的一句提示，不要直接给答案' }
        }
      }
    },
    guides: {
      type: 'array',
      description: '当天每个任务各一条，把任务翻成具体步骤',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['taskTitle', 'steps'],
        properties: {
          taskTitle: { type: 'string', description: '原样照抄任务标题' },
          steps: {
            type: 'array',
            description: '3–5 步，每步都是可直接执行的动作',
            items: { type: 'string' }
          }
        }
      }
    },
    misconceptions: {
      type: 'array',
      description: '2–3 条初学者最容易踩的坑，每条写「误解 → 正确说法」',
      items: { type: 'string' }
    },
    selfCheck: {
      type: 'array',
      description: '3–5 个自检问题，能当场回答就算学会',
      items: { type: 'string' }
    }
  }
}

export const LESSON_SCHEMA = defineSchema<LessonAi>('studyflow_lesson', LESSON_JSON_SCHEMA, lessonAiZ)
