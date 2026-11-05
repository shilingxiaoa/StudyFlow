"""Vercel 入口：把 FastAPI 实例暴露成一个 serverless 函数。

Vercel 的 Python runtime 要求入口文件里有个名为 `app` 的 ASGI 对象，
所以这里只做转发，真正的业务都在 app/main.py。
"""

from app.main import app  # noqa: F401
