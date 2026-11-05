# 部署记录（Vercel）

## 已部署

- 项目名：`studyflow-api`
- 生产别名：`https://studyflow-api-nine.vercel.app`
- 部署命令：`cd server && vercel deploy --prod --yes`
- 认证方式：`VERCEL_TOKEN` 环境变量（不落盘、不写进仓库）

## 已知限制（2026-11-05 实测）

**国内网络无法直连 `*.vercel.app`**：本机对三个 Vercel 边缘 IP 的 443 连接全部失败（`76.76.21.21`、`216.198.79.1` → Connection reset；`202.160.129.6` → 超时 12s），`vercel inspect` 也 `fetch failed`。挂代理可用，但不适合给国内的朋友用。

结论：**Vercel 只作为"能部署成功"的证明和海外备用**；国内可用要在 `docs/07-部署方案对比.md` 里选一条国内能直连的路。

## 重新部署

```powershell
cd D:\deepseek项目\server
$env:VERCEL_TOKEN = '<你的 token>'
vercel deploy --prod --yes
```

## 注意

- `vercel.json` 里**不要写 `functions["api/index.py"].runtime`**：Vercel CLI 会报 `Function Runtimes must have a valid version`。Python 运行时由 `requirements.txt` 自动识别，只需要 `maxDuration`。
- `vercel link` 会生成 `.vercel/` 与 `.env.local`（`server/.gitignore` 已忽略）。
