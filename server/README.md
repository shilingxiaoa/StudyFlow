# StudyFlow 服务端（第一、二步：API 骨架 + SQLite 存储）

目标：先把「服务能起来 → 手机能打开 → 公网能访问」这条链路跑通，再往里加账号、同步、AI 网关。

## 一、本机跑起来（0 成本，5 分钟）

```powershell
cd D:\deepseek项目\server
powershell -ExecutionPolicy Bypass -File .\dev.ps1
```

脚本会：建 `.venv` → 装依赖 → 打印本机与局域网地址 → 启动 uvicorn。

验证：

| 地址 | 说明 |
|---|---|
| http://127.0.0.1:8000/healthz | 本机存活探针 |
| http://<你的局域网 IP>:8000/healthz | **手机连同一个 WiFi 就能打开** |
| http://127.0.0.1:8000/docs | FastAPI 自动生成的接口文档 |

> 手机打不开的排查顺序：① 手机和电脑是不是同一个 WiFi ② Windows 防火墙是否放行了 8000 ③ 电脑 IP 是不是变了（`ipconfig`）

## 二、部署到公网（Vercel，免费、免信用卡）

### 1. 装 CLI 并登录

```powershell
npm i -g vercel
vercel login
```

### 2. 部署

```powershell
cd D:\deepseek项目\server
vercel            # 第一次会问项目名，直接回车用默认
vercel --prod     # 正式环境，给你 https://<项目名>.vercel.app
```

部署完访问 `https://<项目名>.vercel.app/healthz`，手机用流量也能打开 —— 这一步过了，就算「上线」了。

### 3. 环境变量

在 Vercel 项目 → Settings → Environment Variables 里加（不要写进代码）：

| 名字 | 用途 | 现在要不要 |
|---|---|---|
| `ALLOW_ORIGINS` | 允许跨域的来源，逗号分隔 | 建议填 `*`（先跑通），后收紧 |
| `DEEPSEEK_API_KEY` | AI 网关用 | 第二步才需要 |
| `DATABASE_URL` | Neon 连接串 | 第二步才需要 |

改完环境变量要 **Redeploy** 才生效。

## 三、目录说明

```
server/
├── app/main.py        # FastAPI 应用：healthz / ping / echo / info / notes / auth
├── app/db.py          # SQLite：建表 + 增查（一个文件就是一个数据库）
├── app/auth.py        # 账号：注册 / 登录 / JWT 校验
├── api/index.py       # Vercel 入口，只做转发
├── vercel.json        # 单次最长 60s（Python 运行时由 requirements.txt 自动识别）
├── requirements.txt   # 生产依赖
├── data.db            # 运行后自动生成的数据库文件（不入 git）
└── dev.ps1            # 本机一键启动
```

## 四、这个骨架故意没做的事

- **没有真实业务表**：现在只有 `notes` 与 `users`；目标/计划/进度这些等客户端同步那一步再建
- **没有邮箱验证 / 找回密码 / 注销**：只做最小闭环，真上线再补
- **没有 AI**：第四步加网关。Key 只在服务端环境变量里，客户端永远拿不到
- **没有 CI**：后面加 GitHub Actions 跑 ruff + pytest

## 五、数据存储（第二步：SQLite）

现在服务端真的有数据库了：`server/data.db` —— **一个文件就是整个库**，不需要安装、不需要账号、不需要联网。

```powershell
# 启动后打开接口文档，展开 POST /api/notes 点 Try it out
http://127.0.0.1:8000/docs
```

| 接口 | 作用 |
|---|---|
| `POST /api/notes` | 写一条备忘，返回它在库里的 `id` |
| `GET /api/notes` | 按时间倒序读出最近 20 条 |
| `GET /api/notes/stats` | 一共几条 + 数据库文件在哪 |

验证「真的存进文件了」：写一条 → 关掉 uvicorn → 重新启动 → 再 `GET /api/notes`，那条还在。

代码在 `server/app/db.py`：`init_db()` 建表（`CREATE TABLE IF NOT EXISTS`），每次请求开一个连接、用完就关。

> ⚠️ 部署到 Vercel 时这个文件是**临时的**，实例回收后数据会丢。等接真实业务表时换 Neon Postgres（`DATABASE_URL`），接口和表结构基本不用改。

## 六、账号（第三步：注册 / 登录 / JWT）

| 接口 | 说明 |
|---|---|
| `POST /api/auth/register` | 邮箱 + 密码（≥8 位）→ 返回 `token` 与 `user` |
| `POST /api/auth/login` | 邮箱 + 密码 → 返回 `token` |
| `GET /api/auth/me` | **需要** `Authorization: Bearer <token>`，返回当前用户 |

三层必须分清：

1. **密码**：不存明文，存 `scrypt(密码 + 随机盐)` 的哈希（`app/auth.py` 的 `hash_password`）；
2. **token**：登录成功签一个 JWT，自带签名和过期时间（7 天），服务端不记「谁登录了」；
3. **鉴权**：受保护接口用 `Depends(current_user)`，没 token / 签名不对 / 过期 → 401。

在 `/docs` 里试：

1. 调 `POST /api/auth/register`（或 `/login`），复制返回的 `token`
2. 点页面右上角 **Authorize**，粘贴 token（不用加 `Bearer` 前缀）→ Authorize
3. 再调 `GET /api/auth/me`，能看到自己的邮箱和注册时间
4. 点 **Logout** 之后再调 `me`，会得到 401

命令行等价写法：

```bash
curl -X POST http://127.0.0.1:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"studyflow-123"}'

curl http://127.0.0.1:8000/api/auth/me -H "Authorization: Bearer <token>"
```

> 生产环境必须把 `JWT_SECRET` 换成随机长字符串（`python -c "import secrets;print(secrets.token_urlsafe(48))"`），否则别人可以自己伪造 token。

## 七、serverless 的四个坑（先记住，写代码时会撞上）

1. **没有常驻内存**：函数每次冷启动都是新进程，别把任务放内存队列，要用数据库或外部队列
2. **单次请求最长 60s**（本项目配置），AI 长任务要改成「提交任务 → 轮询/SSE 取结果」
3. **冷启动 1–3s**：第一次请求慢是正常的
4. **并发按实例算**：数据库连接一定要用池化连接串（Neon 会给 `-pooler` 那个）
