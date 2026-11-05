"""StudyFlow API —— 第一、二步：API 骨架 + SQLite 存储。

已完成：健康检查、回声、信息接口（证明服务能起来）。
本步新增：notes 表 —— 演示「接口 + 数据库」的最小闭环（写进去、读出来、重启还在）。
下一步会在这里加：账号登录、数据同步、AI 网关。
"""

from __future__ import annotations

import os
import platform
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import AsyncIterator

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import db

APP_VERSION = "0.2.0"


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    # 进程启动时建库建表；表已存在则什么都不做。
    db.init_db()
    print(f"[db] SQLite 就绪：{db.DB_PATH}")
    yield


app = FastAPI(
    title="StudyFlow API",
    version=APP_VERSION,
    description="StudyFlow 的服务端：先跑通链路，再逐步加账号 / 同步 / AI 网关。",
    lifespan=lifespan,
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


# ---------------------------------------------------------------- 数据库演示
class NoteIn(BaseModel):
    text: str = Field(
        min_length=1,
        max_length=500,
        examples=["今天学会了：后端 = 接口 + 数据库"],
    )


class NoteOut(BaseModel):
    id: int
    text: str
    created_at: str


@app.post("/api/notes", tags=["notes"], response_model=NoteOut)
def create_note(payload: NoteIn) -> NoteOut:
    """写一条备忘到数据库，返回它在库里的编号。"""
    return NoteOut(**db.create_note(payload.text))


@app.get("/api/notes", tags=["notes"], response_model=list[NoteOut])
def get_notes(limit: int = Query(20, ge=1, le=100)) -> list[NoteOut]:
    """按时间倒序读出最近的备忘记。重启服务后这些数据仍然在。"""
    return [NoteOut(**row) for row in db.list_notes(limit)]


@app.get("/api/notes/stats", tags=["notes"])
def note_stats() -> dict[str, object]:
    """一共存了多少条 —— 用来证明数据真的进了文件。"""
    return {"count": db.count_notes(), "db_path": str(db.DB_PATH)}

