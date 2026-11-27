# StudyFlow — 代码代理交接说明（AGENTS.md）

> 任何 AI 编码代理（Codex / Claude Code / Cursor / 其他）接手本仓库前，先读完这一页。
> 人类维护者：`shilingxiaoa`。项目根：`D:\deepseek项目`（Windows）。当前版本 **v1.8.1**。

## 1. 一句话认识

把「我要学 X」拆成每天能照着做的任务，AI 出题验收，通过才涨进度的 Windows 桌面应用。

- 技术栈：Electron 44 + electron-vite 6 + React 19 + TypeScript 7 + sql.js(WASM) + Zustand
- AI：只接 DeepSeek（`deepseek-flash`），单机优先、无云端、无遥测
- 形态：本地多账号（`accounts.db` + `users/<id>/studyflow.db`），资料导入（md/txt/docx/pptx）

## 2. 目录与职责

| 路径 | 作用 | 能不能随便改 |
|---|---|---|
| `src/shared/contracts.ts` | **唯一契约**：类型、IPC/PUSH 通道、计分常量 | 改必须同步主进程+渲染层，**同一时间只允许一个 agent 改** |
| `src/main/` | 主进程：DB、AI、IPC、更新 | 可以，但别绕开 `repo.ts` / `client.ts` |
| `src/renderer/` | React 界面 | 可以，只能用 `window.api.invoke` |
| `src/main/db/schema.sql` | 表结构 | 只加不改；老库靠启动时 `PRAGMA`/`UPDATE` 自愈 |
| `scripts/` | 冒烟、截图、素材、打包 | 可以，改完必须跑通 |
| `server/` | FastAPI 实验（账号/同步预备），**还没接客户端** | 可以，别假设它在线上 |
| `site/` | GitHub Pages 下载页 | 可以 |
| `docs/` | 01 产品 / 02 技术设计 / 03 DeepSeek API 备忘 / 04 技术方案 / 05 上线路线图 / 06 发版检查表 / 07 交接清单 | 改文档请保持和代码同步 |

## 3. 命令（Windows PowerShell，本机没有 pnpm）

```powershell
npm install            # 依赖（走 npmmirror 镜像）
npm run dev            # 开发模式
npm run typecheck      # 主进程 + 渲染层两套 tsc（TS7：无 baseUrl，paths 用相对路径）
npm run verify         # typecheck + schema-lint（pre-commit 也会跑）
npm run smoke          # ★ 真实 Electron 冒烟 82 项，直调 IPC
npm run build          # electron-vite 构建到 out/
npm run dist           # 打包安装版 + 便携版到 release/
npm run smoke:packaged # 对打包产物再跑一遍冒烟
node scripts/smoke.mjs scripts/shots-flow.js .shots   # 重拍界面截图
```

> 冒烟是**唯一可信的验收**：它启动真实 Electron、注入脚本、按 IPC 跑完整业务链路并断言 `stats` 归零。
> 改完任何主进程/契约/DB 代码，`npm run smoke` 必须 82/82。

## 4. 必须遵守的不变量（踩过坑）

1. **契约唯一真源**：新通道要同时加 `IPC`（或 `PUSH`）常量和类型；`preload` 白名单由 `Object.values(IPC)` 派生，**不要手写**。
2. **渲染层不碰 Node**：不能 `require('fs')`、不能用 `net`；一律 `window.api.invoke`。
3. **数据库只有一个入口**：`src/main/db/repo.ts`。`database.ts` 的 `activeFilePath` 决定当前打开哪个 `.db`（多账号=换文件），未登录时 `ensureReady()` 抛 `AUTH_REQUIRED`。
4. **AI 只走 `src/main/ai/client.ts`**：`responsesJSON` / `chatText`。schema 必须 strict 且**禁止联合类型**（`type: ['array','null']` 会 400，schema-lint 已拦）。
5. **结构化调用必须 `reasoning.effort='none'`**，`maxOutputTokens ≥ 12k`：否则思考 token 吃光正文，返回空 content（历史事故，见 docs/04）。
6. **版本号只在 `package.json`**：渲染层用 `__APP_VERSION__` 注入，不要在 `layout.tsx` 手写。
7. **不要给 Day 加「解锁」概念**：v1.3 起所有 Day 都是 `learning`，任意一天可检测。
8. **历史数据不重算**：计分口径变了（v1.2 40/60、v1.4 70/30），旧记录按当时分值展示，别做「迁移刷分」。

## 5. 本机环境坑（每次都踩）

- **`ELECTRON_RUN_AS_NODE` 必须先清**：`Remove-Item Env:ELECTRON_RUN_AS_NODE`，否则 Electron 退化成 Node，报 `Cannot read properties of undefined (reading 'isPackaged')`。
- **别用 PowerShell 改中文文本文件**：`Set-Content -Encoding UTF8` 会写 BOM（vite 的 jsonLoader 直接报错）、`node -e "…"` 会被 `$`/反引号吞掉。正确做法：用编辑器/`write`/`edit` 工具，或写一个 `.mjs` 临时脚本再 `node` 跑。
- **截图慢一帧**：`capturePage()` 需要延迟（`src/main/index.ts` 的 `[shot]` 处理里已设 1500ms + rAF 等待），别调小。
- **GitHub**：`github.com` 直连看代理（FlClash 混合端口 7890）；`api.github.com` 可直连但未认证会 hit rate limit；`git push` 的 stderr 在 PowerShell 里会显示成 NativeCommandError，**实际可能成功**，用 `git log origin/main` 核对。
- **打包**：`release/` 产物体积大（安装版 ~128MB），没有代码签名，SmartScreen 会提示「未知发布者」。

## 6. 完成定义（DoD）

1. `npm run verify` 通过（两套 tsc + schema-lint）
2. `npm run smoke` **82/82**（改了打包/更新相关再跑 `npm run smoke:packaged`）
3. 相关文档同步：README 能力/验收表、CHANGELOG、`docs/04` 或 `docs/05`
4. 提交：中文 conventional commit（`feat:`/`fix:`/`docs:`/`chore:`），一次一件事
5. 发版（仅当用户要求）：版本号 + CHANGELOG + tag + push，流程见 `docs/06-发版检查表.md`

## 7. 当前状态与缺口（2026-11-27）

- 版本 `v1.8.1`，`main` 干净，13 个 tag。
- P0 打包 ✅；P1 分发/自动更新 🟡（**差 GitHub Pages 开关**：仓库 Settings → Pages → Source 选 GitHub Actions）。
- P2 账号与同步：本地账号 ✅，服务端 `server/` 有骨架（FastAPI + SQLite + JWT），**未接客户端、无托管数据库**。
- P3 AI 网关 / P4 商业化：未开始。
- 用户下一步未定：A（0 元「导出/导入」文件同步）或 B（¥100/年 国内 VPS）。
- 遗留：v1.8.0 的 **draft Release** 可删；`release/` 里 1.4–1.8 的旧包可清。

## 8. 协作规则（多个 agent 同时干活时）

- `src/shared/contracts.ts`、`src/main/db/schema.sql` 是**单写者文件**：开工前声明，改完立刻提交并通知其他 agent 重新读。
- 不要同时跑两个 `npm run build` / `npm run dist`（会抢 `out/`、`release/`）。
- 界面改动按页面划分（`pages/X.tsx` + `X.css` 成对改），不要跨文件大改。
- 发现问题先写一句「现象 + 复现 + 怀疑点」进 `docs/07-交接清单.md`，再动手。
