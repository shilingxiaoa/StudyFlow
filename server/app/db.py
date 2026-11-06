"""SQLite 数据库：一个文件就是整个数据库。

为什么先用 SQLite：
- 不需要安装、不需要账号、不需要联网，`data.db` 就是一个文件；
- 和 StudyFlow 客户端本地库是同一种技术，容易对照理解；
- 以后换成 Postgres 时，只要改连接方式，接口和表结构基本不变。

注意：如果部署到 Vercel 这类 serverless 平台，文件系统是临时的，
写进去的数据在实例回收后会丢。真正上线要换成 Postgres 或挂载持久化磁盘。
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

# 允许用环境变量覆盖（部署时指向持久化磁盘）；默认放 server/data.db
DB_PATH = Path(
    os.getenv("STUDYFLOW_DB") or Path(__file__).resolve().parent.parent / "data.db"
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def get_conn() -> Iterator[sqlite3.Connection]:
    """每次请求开一个连接，用完就关（SQLite 的推荐用法）。"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    """建库建表。重复调用是安全的（IF NOT EXISTS）。"""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_conn() as conn:
        conn.executescript(SCHEMA)


def create_note(text: str) -> dict[str, object]:
    created_at = _now()
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO notes (text, created_at) VALUES (?, ?)", (text, created_at)
        )
        return {"id": cur.lastrowid, "text": text, "created_at": created_at}


def list_notes(limit: int = 20) -> list[dict[str, object]]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, text, created_at FROM notes ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(row) for row in rows]


def count_notes() -> int:
    with get_conn() as conn:
        row = conn.execute("SELECT COUNT(*) AS n FROM notes").fetchone()
    return int(row["n"])


# ------------------------------------------------------------------- 用户
def create_user(email: str, password_hash: str) -> dict[str, object]:
    """插入一个用户；邮箱重复时抛 sqlite3.IntegrityError，由调用方翻译成业务错误。"""
    created_at = _now()
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)",
            (email, password_hash, created_at),
        )
        return {
            "id": cur.lastrowid,
            "email": email,
            "password_hash": password_hash,
            "created_at": created_at,
        }


def get_user_by_email(email: str) -> dict[str, object] | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, email, password_hash, created_at FROM users WHERE email = ?",
            (email,),
        ).fetchone()
    return dict(row) if row else None


def get_user_by_id(user_id: int) -> dict[str, object] | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, email, password_hash, created_at FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    return dict(row) if row else None


def count_users() -> int:
    with get_conn() as conn:
        row = conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()
    return int(row["n"])
