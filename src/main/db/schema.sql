-- StudyFlow 数据表结构（sql.js / SQLite 3）
-- 约定：主键 TEXT（uuid），时间一律 ISO 字符串，数组/对象存 JSON 文本。
-- 全部 IF NOT EXISTS，可重复执行；执行前需 PRAGMA foreign_keys = ON。
-- goal.progress 不落库（契约要求实时算：Σ(day.progress×estMinutes)/Σ estMinutes）。

CREATE TABLE IF NOT EXISTS goal (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL DEFAULT 'exam',      -- exam | skill | course | project
  level         TEXT NOT NULL DEFAULT 'zero',      -- zero | basic | some | good
  target_date   TEXT,                              -- YYYY-MM-DD | NULL
  daily_minutes INTEGER NOT NULL DEFAULT 60,
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan (
  id            TEXT PRIMARY KEY,
  goal_id       TEXT NOT NULL,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  total_days    INTEGER NOT NULL DEFAULT 0,
  total_minutes INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',    -- draft | active | archived
  version       INTEGER NOT NULL DEFAULT 1,
  model         TEXT NOT NULL DEFAULT '',
  raw_json      TEXT NOT NULL DEFAULT '{}',        -- AI 原始输出，便于排查
  created_at    TEXT NOT NULL,
  FOREIGN KEY (goal_id) REFERENCES goal(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS day (
  id            TEXT PRIMARY KEY,
  plan_id       TEXT NOT NULL,
  goal_id       TEXT NOT NULL,
  idx           INTEGER NOT NULL,                  -- 第几天，从 1 开始
  title         TEXT NOT NULL,
  goal          TEXT NOT NULL DEFAULT '',
  est_minutes   INTEGER NOT NULL DEFAULT 60,
  status        TEXT NOT NULL DEFAULT 'locked',    -- locked | learning | exam_ready | passed | partial | failed
  progress      REAL NOT NULL DEFAULT 0,           -- 1 通过 / 0.6 部分通过 / 0 其余
  score         REAL,
  exam_id       TEXT,                              -- 最近一次考试（不加外键，避免与 exam 循环）
  checkpoints   TEXT NOT NULL DEFAULT '[]',        -- JSON string[]
  created_at    TEXT NOT NULL,
  FOREIGN KEY (plan_id) REFERENCES plan(id) ON DELETE CASCADE,
  FOREIGN KEY (goal_id) REFERENCES goal(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task (
  id            TEXT PRIMARY KEY,
  day_id        TEXT NOT NULL,
  idx           INTEGER NOT NULL,
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'other',     -- read | watch | practice | write | review | other
  est_minutes   INTEGER NOT NULL DEFAULT 15,
  status        TEXT NOT NULL DEFAULT 'todo',      -- todo | doing | done | skipped
  note          TEXT,
  done_at       TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (day_id) REFERENCES day(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS exam (
  id               TEXT PRIMARY KEY,
  day_id           TEXT NOT NULL,
  goal_id          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending', -- pending | objective_done | grading | graded
  objective_score  REAL,
  recitation_score REAL,
  total_score      REAL,
  passed           INTEGER,
  created_at       TEXT NOT NULL,
  graded_at        TEXT,
  FOREIGN KEY (day_id) REFERENCES day(id) ON DELETE CASCADE,
  FOREIGN KEY (goal_id) REFERENCES goal(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS question (
  id              TEXT PRIMARY KEY,
  day_id          TEXT NOT NULL,
  exam_id         TEXT NOT NULL,
  idx             INTEGER NOT NULL,
  type            TEXT NOT NULL,                   -- single_choice | fill_blank
  knowledge_point TEXT NOT NULL DEFAULT '',
  stem            TEXT NOT NULL,
  options         TEXT NOT NULL DEFAULT '[]',      -- JSON string[]
  answer          TEXT NOT NULL,                   -- 单选存下标字符串；填空存标准答案
  answer_aliases  TEXT NOT NULL DEFAULT '[]',      -- JSON string[]
  explanation     TEXT NOT NULL DEFAULT '',
  point           REAL NOT NULL DEFAULT 25,
  user_answer     TEXT,
  correct         INTEGER,
  FOREIGN KEY (day_id) REFERENCES day(id) ON DELETE CASCADE,
  FOREIGN KEY (exam_id) REFERENCES exam(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recitation (
  id            TEXT PRIMARY KEY,
  exam_id       TEXT NOT NULL,
  day_id        TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  key_points    TEXT NOT NULL DEFAULT '[]',        -- JSON string[]，绝不下发前端
  messages      TEXT NOT NULL DEFAULT '[]',        -- JSON RecitationMessage[]
  follow_up     TEXT,
  status        TEXT NOT NULL DEFAULT 'awaiting_explain', -- awaiting_explain | awaiting_followup_answer | grading | graded
  dimensions    TEXT,                              -- JSON RecitationDimensions（0-1 原始达成度）
  score         REAL,
  feedback      TEXT,
  critical_gap  TEXT,
  created_at    TEXT NOT NULL,
  graded_at     TEXT,
  FOREIGN KEY (exam_id) REFERENCES exam(id) ON DELETE CASCADE,
  FOREIGN KEY (day_id) REFERENCES day(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS progress_event (
  id          TEXT PRIMARY KEY,
  goal_id     TEXT NOT NULL,
  day_id      TEXT,
  delta       REAL NOT NULL DEFAULT 0,             -- 有符号：正=增长 负=回退
  reason      TEXT NOT NULL DEFAULT 'manual',      -- day_passed | day_partial | review_failed | review_passed | manual
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  FOREIGN KEY (goal_id) REFERENCES goal(id) ON DELETE CASCADE,
  FOREIGN KEY (day_id) REFERENCES day(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS material (
  id          TEXT PRIMARY KEY,
  goal_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'text',        -- text | chapter | link | note
  content     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  FOREIGN KEY (goal_id) REFERENCES goal(id) ON DELETE CASCADE
);

-- 每日教案：一天一份，AI 生成后缓存，重新备课会覆盖
CREATE TABLE IF NOT EXISTS lesson (
  day_id      TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'empty',       -- empty | generating | ready | failed
  payload     TEXT NOT NULL DEFAULT '',            -- JSON: {title, overview, sections, practices, guides, misconceptions, selfCheck}
  error       TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (day_id) REFERENCES day(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id                TEXT PRIMARY KEY,
  scene             TEXT NOT NULL,                 -- plan | exam | recitation | review
  model             TEXT NOT NULL DEFAULT '',
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cache_hit_tokens  INTEGER NOT NULL DEFAULT 0,
  cost              REAL NOT NULL DEFAULT 0,       -- 元
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  ok                INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_config (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plan_goal     ON plan(goal_id);
CREATE INDEX IF NOT EXISTS idx_day_plan      ON day(plan_id);
CREATE INDEX IF NOT EXISTS idx_day_goal      ON day(goal_id);
CREATE INDEX IF NOT EXISTS idx_task_day      ON task(day_id);
CREATE INDEX IF NOT EXISTS idx_exam_day      ON exam(day_id);
CREATE INDEX IF NOT EXISTS idx_question_day  ON question(day_id);
CREATE INDEX IF NOT EXISTS idx_question_exam ON question(exam_id);
CREATE INDEX IF NOT EXISTS idx_recite_exam   ON recitation(exam_id);
CREATE INDEX IF NOT EXISTS idx_event_goal    ON progress_event(goal_id);
CREATE INDEX IF NOT EXISTS idx_material_goal ON material(goal_id);
CREATE INDEX IF NOT EXISTS idx_lesson_status ON lesson(status);
CREATE INDEX IF NOT EXISTS idx_usage_created ON ai_usage(created_at);
