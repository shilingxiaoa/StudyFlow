"""StudyFlow API —— 第一步：纯 API 骨架。

现在只有健康检查和一个回声接口，用来先把「服务能起来、手机能打开」这条链路跑通。
下一步会在这里加：账号登录、数据同步、AI 网关。
"""

from __future__ import annotations

import os
import platform
import sys
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

APP_VERSION = "0.1.0"

app = FastAPI(
    title="StudyFlow API",
    version=APP_VERSION,
    description="StudyFlow 的服务端：先跑通链路，再逐步加账号 / 同步 / AI 网关。",
)

# 桌面客户端（Electron 的 file:// 或 http://localhost）需要跨域访问。
# 生产环境记得把 ALLOW_ORIGINS 收窄成你自己的域名。
_origins = [o.strip() for o in os.getenv("ALLOW_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@app.get("/healthz", tags=["ops"])
def healthz() -> dict[str, object]:
    """存活探针：只证明进程活着，不碰数据库。"""
    return {"status": "ok", "version": APP_VERSION, "time": _now()}


@app.get("/api/ping", tags=["demo"])
def ping() -> dict[str, object]:
    """给客户端做连通性测试用。"""
    return {"pong": True, "time": _now()}


class EchoIn(BaseModel):
    text: str = Field(min_length=1, max_length=500)


@app.post("/api/echo", tags=["demo"])
def echo(payload: EchoIn) -> dict[str, object]:
    """验证请求体、UTF-8 中文、JSON 往返是否正常。"""
    return {"text": payload.text, "length": len(payload.text), "time": _now()}


@app.get("/api/info", tags=["ops"])
def info() -> dict[str, object]:
    """部署排查用：看清跑在什么解释器、什么平台上。"""
    return {
        "version": APP_VERSION,
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "region": os.getenv("VERCEL_REGION", "local"),
        "time": _now(),
    }
