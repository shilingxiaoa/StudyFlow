/**
 * 全局契约 —— 渲染进程、主进程、AI 层共享的唯一类型与通道定义。
 * ⚠️ 本文件由 Lead 独占维护，其他 agent 只读不改；如需新增字段，在任务里提出。
 */

// ───────────────────────────── 基础 ─────────────────────────────

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ErrorCode; message: string } };

export type ErrorCode =
  | 'NO_API_KEY'
  | 'INVALID_API_KEY'
  | 'INSUFFICIENT_BALANCE'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'AI_BAD_OUTPUT'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'DB'
  | 'AUTH_REQUIRED'
  | 'AUTH_FAILED'
  | 'UNKNOWN';

export const MODEL_ID = 'deepseek-flash'; // = DeepSeek-V4.1-Flash-1017
export const API_BASE = 'https://api.deepseek.com';

// ───────────────────────────── 目标 / 计划 ─────────────────────────────

export type GoalKind = 'exam' | 'skill' | 'course' | 'project';
export type GoalLevel = 'zero' | 'basic' | 'some' | 'good';

export interface Goal {
  id: string;
  title: string;
  /** 用户原始描述 / 目标文档全文（进 prompt 前缀，吃 KVCache） */
  description: string;
  kind: GoalKind;
  level: GoalLevel;
  /** YYYY-MM-DD，可空 */
  targetDate: string | null;
  /** 每日可投入分钟数 */
  dailyMinutes: number;
  /** 0–100，由 progress_event 实时算出 */
  progress: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GoalInput {
  title: string;
  description: string;
  kind: GoalKind;
  level: GoalLevel;
  targetDate?: string | null;
  dailyMinutes: number;
}

export type PlanStatus = 'draft' | 'active' | 'archived';

export interface Plan {
  id: string;
  goalId: string;
  title: string;
  summary: string;
  totalDays: number;
  totalMinutes: number;
  status: PlanStatus;
  version: number;
  model: string;
  createdAt: string;
}

/** AI 生成、尚未入库的计划 */
export interface GeneratedPlan {
  title: string;
  summary: string;
  totalDays: number;
  days: GeneratedDay[];
}

export interface GeneratedDay {
  index: number;
  title: string;
  /** 这一天要学会什么（一句话） */
  goal: string;
  estMinutes: number;
  /** 可检验的完成标志 */
  checkpoints: string[];
  tasks: { title: string; kind: TaskKind; estMinutes: number }[];
}

export interface PlanSummary extends Plan {
  goalTitle: string;
  passedDays: number;
}

// ───────────────────────────── Day / Task ─────────────────────────────

export type DayStatus = 'locked' | 'learning' | 'exam_ready' | 'passed' | 'partial' | 'failed';
export type TaskKind = 'read' | 'watch' | 'practice' | 'write' | 'review' | 'other';
export type TaskStatus = 'todo' | 'doing' | 'done' | 'skipped';

export interface Task {
  id: string;
  dayId: string;
  index: number;
  title: string;
  kind: TaskKind;
  estMinutes: number;
  status: TaskStatus;
  note: string | null;
  doneAt: string | null;
}

export interface Day {
  id: string;
  planId: string;
  index: number;
  title: string;
  goal: string;
  estMinutes: number;
  checkpoints: string[];
  status: DayStatus;
  /** 0 / 0.6 / 1 / 0.5(复检降级后) */
  progress: number;
  score: number | null;
  /** 最近一次考试的 examId */
  examId: string | null;
}

export interface DayWithTasks extends Day {
  tasks: Task[];
}

export interface DayDetail extends DayWithTasks {
  planTitle: string;
  goalId: string;
  goalTitle: string;
}

// ───────────────────────────── 目标题 / 考试 ─────────────────────────────

export type QuestionType = 'single_choice' | 'fill_blank';

export interface Question {
  id: string;
  dayId: string;
  examId: string;
  index: number;
  type: QuestionType;
  /** 25 分 */
  point: number;
  /** 考查的知识点（复盘时展示） */
  knowledgePoint: string;
  stem: string;
  options: string[] | null; // single_choice 才有
  /** 正确答案：选项下标(0-based) 或 填空标准答案 */
  answer: string;
  answerAliases: string[];
  explanation: string;
  /** 已提交的作答（未提交为 null）——仅用于考后回顾 */
  userAnswer?: string | null;
  /** 是否答对（未提交为 null）——仅用于考后回顾 */
  correct?: boolean | null;
}

export type ExamStatus = 'pending' | 'objective_done' | 'graded';

export interface Exam {
  id: string;
  dayId: string;
  status: ExamStatus;
  objectiveScore: number | null;
  recitationScore: number | null;
  totalScore: number | null;
  passed: boolean | null;
  createdAt: string;
  gradedAt: string | null;
}

/** 出题结果（AI 返回，写库后返回给渲染进程） */
export interface ExamPayload {
  exam: Exam;
  questions: Question[];
  recitation: RecitationTask;
}

export interface RecitationTask {
  id: string;
  examId: string;
  status: RecitationStatus;
  /** 题面：学生场景说明 */
  prompt: string;
  /** 隐藏要点，前端不展示 */
  keyPoints?: string[];
}

export type RecitationStatus =
  | 'awaiting_explain'
  | 'awaiting_followup_answer'
  | 'grading'
  | 'graded';

export interface RecitationMessage {
  role: 'user' | 'student';
  text: string;
  at: string;
}

/** 前端可见的问答状态（不含隐藏要点） */
export interface RecitationView {
  id: string;
  examId: string;
  status: RecitationStatus;
  prompt: string;
  messages: RecitationMessage[];
  followUp: string | null;
  /** graded 时才有 */
  score: number | null;
  dimensions: RecitationDimensions | null;
  feedback: string | null;
  criticalGap: string | null;
}

export interface RecitationDimensions {
  accuracy: number; // 0–1
  coverage: number;
  example: number;
  clarity: number;
}

export interface ExamObjectiveResult {
  exam: Exam;
  perQuestion: {
    questionId: string;
    correct: boolean;
    userAnswer: string;
    answer: string;
    explanation: string;
  }[];
  objectiveScore: number;
}

export interface ExamGradeResult {
  exam: Exam;
  totalScore: number;
  passed: boolean;
  /** 客观题明细 */
  objective: ExamObjectiveResult['perQuestion'];
  recitation: RecitationView;
  /** 下一步建议 */
  advice: string;
}

// ───────────────────────────── 进度 ─────────────────────────────

export interface ProgressEvent {
  id: string;
  goalId: string;
  dayId: string | null;
  /** 有符号，正=增长 负=回退 */
  delta: number;
  reason: 'day_passed' | 'day_partial' | 'review_failed' | 'review_passed' | 'manual';
  detail: string;
  createdAt: string;
}

export interface ProgressSummary {
  goalId: string;
  /** 0–100，保留 1 位小数 */
  percent: number;
  totalDays: number;
  passedDays: number;
  partialDays: number;
  /** 按 Day 序的分段进度 */
  segments: { dayId: string; index: number; title: string; progress: number; status: DayStatus }[];
  /** 最近 7 天学习分钟数 */
  weekMinutes: number;
}

// ───────────────────────────── 复检 ─────────────────────────────

export interface ReviewPayload {
  goalId: string;
  questions: Question[];
  dayIds: string[];
}

export interface ReviewResult {
  passed: boolean;
  perQuestion: ExamObjectiveResult['perQuestion'];
  /** 回退或恢复后的新百分比 */
  percent: number;
  delta: number;
}

// ───────────────────────────── 资料 ─────────────────────────────

export type MaterialKind = 'text' | 'chapter' | 'link' | 'note';

export interface Material {
  id: string;
  goalId: string;
  title: string;
  kind: MaterialKind;
  content: string;
  createdAt: string;
}

/** material:import 的结果：导入成功了几份、哪几份被跳过以及原因 */
export interface MaterialImportResult {
  /** 该目标当前的全部资料（含本次导入的） */
  materials: Material[];
  imported: number;
  skipped: { name: string; reason: string }[];
}

// ───────────────────────────── 每日教案 ─────────────────────────────

export type LessonStatus = 'empty' | 'generating' | 'ready' | 'failed';

/** 教案的一节讲解 */
export interface LessonSection {
  title: string;
  /** 建议用时（分钟） */
  minutes: number;
  /** Markdown 正文：段落、列表、代码块、引用 */
  body: string;
}

export type PracticeKind = 'exercise' | 'recall' | 'apply';

/** 教案里的练习：答案默认折叠，自己先做再看 */
export interface LessonPractice {
  kind: PracticeKind;
  prompt: string;
  answer: string;
  hint: string;
}

/** 把当天任务翻成「具体怎么做」的步骤 */
export interface LessonGuide {
  /** 与任务标题对应 */
  taskTitle: string;
  steps: string[];
}

export interface Lesson {
  dayId: string;
  status: LessonStatus;
  title: string;
  /** 学完能做到什么 */
  overview: string;
  sections: LessonSection[];
  practices: LessonPractice[];
  guides: LessonGuide[];
  /** 常见误解 */
  misconceptions: string[];
  /** 自检清单：能答上来才算学会 */
  selfCheck: string[];
  /** 生成失败时的可读原因 */
  error: string | null;
  updatedAt: string | null;
}

/** lesson:ask 的回答 */
export interface LessonAskResult {
  answer: string;
}

// ───────────────────────────── 设置 / 统计 ─────────────────────────────

export interface AppSettings {
  hasApiKey: boolean;
  baseUrl: string;
  model: string;
  theme: 'dark' | 'light' | 'system';
  dailyMinutes: number;
  remindEnabled: boolean;
  remindTime: string; // HH:mm
  reviewEnabled: boolean;
  reviewEveryDays: number;
  reviewEveryWeekdays: number;
}

export interface StatsOverview {
  totalGoals: number;
  activeGoals: number;
  totalDaysPassed: number;
  totalMinutes: number;
  /** 近 14 天每日学习分钟 */
  dailyMinutes: { date: string; minutes: number }[];
  /** 本月 AI 成本（元） */
  monthCost: number;
  streakDays: number;
}

export interface BootstrapData {
  settings: AppSettings;
  goals: Goal[];
  /** 当前正在看的目标 id；没有目标时为 null */
  activeGoalId: string | null;
  /** 当前目标下的全部计划（新的在前），第一份通常是 active */
  plans: PlanSummary[];
  activePlan: PlanSummary | null;
  progress: ProgressSummary | null;
  todayDay: DayWithTasks | null;
  stats: StatsOverview;
}

/** context:set 的入参：切目标 / 切计划；传 null 表示清空，缺省表示不变 */
export interface ContextInput {
  goalId?: string | null;
  planId?: string | null;
}

// ───────────────────────────── 账号（本地登录） ─────────────────────────────

/** 本机账号；不联网、不上传，密码只存加盐哈希 */
export interface AuthAccount {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  /** 上一次登录时间；从未登录过为 null */
  lastLoginAt: string | null;
}

/**
 * 登录状态。渲染进程启动时先问这个，再决定显示登录页还是主界面。
 *  - hasAccounts=false 且 legacyDataAvailable=true：第一次升级到带登录的版本，
 *    提示用户「用现有数据创建账号」。
 *  - remember=true：下次启动可以免密码进入（可在设置里关掉）。
 */
export interface AuthStatus {
  authenticated: boolean;
  account: AuthAccount | null;
  hasAccounts: boolean;
  /** 这台电脑上存在登录功能之前留下的学习数据，可以归到新账号 */
  legacyDataAvailable: boolean;
}

// ───────────────────────────── IPC 通道表 ─────────────────────────────

export const IPC = {
  APP_BOOTSTRAP: 'app:bootstrap',

  AUTH_STATUS: 'auth:status',
  AUTH_REGISTER: 'auth:register',
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_CHANGE_PASSWORD: 'auth:changePassword',

  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',
  SETTINGS_SET_KEY: 'settings:setApiKey',
  SETTINGS_TEST_KEY: 'settings:testApiKey',

  GOAL_LIST: 'goal:list',
  GOAL_CREATE: 'goal:create',
  GOAL_UPDATE: 'goal:update',
  GOAL_DELETE: 'goal:delete',

  PLAN_GENERATE: 'plan:generate',
  PLAN_SAVE: 'plan:save',
  PLAN_LIST: 'plan:list',
  PLAN_DELETE: 'plan:delete',

  /** 切换「当前目标 / 当前计划」，返回新的 BootstrapData */
  CONTEXT_SET: 'context:set',

  DAY_LIST: 'day:list',
  DAY_GET: 'day:get',
  TASK_SET_STATUS: 'task:setStatus',

  EXAM_CREATE: 'exam:create',
  EXAM_GET: 'exam:get',
  EXAM_SUBMIT_OBJECTIVE: 'exam:submitObjective',

  RECITATION_START: 'recitation:start',
  RECITATION_SAY: 'recitation:say',
  RECITATION_SUBMIT: 'recitation:submit',

  PROGRESS_SUMMARY: 'progress:summary',
  PROGRESS_EVENTS: 'progress:events',

  REVIEW_CREATE: 'review:create',
  REVIEW_SUBMIT: 'review:submit',

  MATERIAL_LIST: 'material:list',
  MATERIAL_ADD: 'material:add',
  MATERIAL_DELETE: 'material:delete',
  MATERIAL_IMPORT: 'material:import',

  LESSON_GET: 'lesson:get',
  LESSON_GENERATE: 'lesson:generate',
  LESSON_ASK: 'lesson:ask',

  STATS_OVERVIEW: 'stats:overview',
  EXPORT_MARKDOWN: 'export:markdown',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** 主进程主动推送 */
export const PUSH = {
  PROGRESS_CHANGED: 'push:progressChanged',
  TASK_CHANGED: 'push:taskChanged',
  SETTINGS_CHANGED: 'push:settingsChanged',
  AI_STAGE: 'push:aiStage',
  /** 登录状态变了（登录 / 退出 / 改密码后重新建会话）；payload 是 AuthStatus */
  AUTH_CHANGED: 'push:authChanged',
} as const;

export interface AiStage {
  scene: 'plan' | 'exam' | 'recitation' | 'review' | 'lesson' | 'ask';
  stage: string;
  percent: number | null;
}

// ───────────────────────────── Preload 暴露面 ─────────────────────────────

/** 渲染进程可用的 window.api（由 preload 实现） */
export interface RendererApi {
  invoke<T>(channel: IpcChannel, payload?: unknown): Promise<Result<T>>;
  on(channel: IpcChannel | string, cb: (payload: unknown) => void): () => void;
  platform: 'win32' | 'darwin' | 'linux';
}

// ───────────────────────────── 业务常量 ─────────────────────────────

export const SCORING = {
  /** 客观题：7 道单选，每题 10 分 */
  objectivePerQuestion: 10,
  objectiveTotal: 70,
  objectiveCount: 7,
  /** 问答（原来的费曼复述改成了 AI 提问、你来回答） */
  recitationTotal: 30,
  recitationQuestionCount: 2,
  /** 只看准确性/完整性/清晰度；example 恒为 0（历史数据仍按 0 权计算，界面不再展示） */
  recitationWeights: { accuracy: 18, coverage: 7, example: 0, clarity: 5 },
  passLine: 80,
  partialLine: 60,
  partialCredit: 0.6,
  reviewPenalty: -0.2,
  /** 问答每题最少字数：只挡住「哦」「不知道」这类，不惩罚简短回答 */
  minAnswerChars: 15,
  minFollowupChars: 15,
  /** 结果页两段点评的兜底上限（正常由 prompt 控制长度，超长按句子边界截断） */
  feedbackMaxChars: 400,
  criticalGapMaxChars: 120,
} as const;

export const DAY_STATUS_LABEL: Record<DayStatus, string> = {
  locked: '可学习',
  learning: '学习中',
  exam_ready: '待检测',
  passed: '已通过',
  partial: '部分通过',
  failed: '未通过',
};
