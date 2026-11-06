"""账号：注册、登录、查自己。

三个必须理解的东西：
1. 密码不存明文，只存 `scrypt` 派生出来的哈希（+ 随机盐），数据库泄露也拿不到原密码；
2. 登录成功返回一个 JWT（一段签名字符串），客户端之后把它放进请求头
   `Authorization: Bearer <token>`；
3. 服务端不记「谁登录了」，只验「这段签名对不对、有没有过期」—— 这叫无状态。
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import time
from typing import Any

import jwt
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from . import db

router = APIRouter(prefix="/api/auth", tags=["auth"])
_bearer = HTTPBearer(auto_error=False)

JWT_SECRET = os.getenv("JWT_SECRET", "dev-secret-change-me")
JWT_ALGORITHM = "HS256"
TOKEN_TTL_SECONDS = 7 * 24 * 3600
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")

# scrypt 参数：n=2^14 在本机约 40ms，足够挡住暴力猜密码，又不拖慢接口
_SCRYPT_N, _SCRYPT_R, _SCRYPT_P, _SCRYPT_LEN = 2**14, 8, 1, 32


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=_SCRYPT_LEN,
    )
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, salt_hex, digest_hex = stored.split("$")
    except ValueError:
        return False
    if scheme != "scrypt":
        return False
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=bytes.fromhex(salt_hex),
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=_SCRYPT_LEN,
    )
    return hmac.compare_digest(digest.hex(), digest_hex)


def create_token(user_id: int, email: str) -> str:
    now = int(time.time())
    payload = {"sub": str(user_id), "email": email, "iat": now, "exp": now + TOKEN_TTL_SECONDS}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    """对外只暴露这三个字段，password_hash 永远不出门。"""
    return {"id": user["id"], "email": user["email"], "created_at": user["created_at"]}


def _bad_credentials() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="邮箱或密码不正确",
        headers={"WWW-Authenticate": "Bearer"},
    )


def current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict[str, Any]:
    """依赖注入：任何需要登录的接口，把它加进参数就自动校验 token。"""
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="需要登录：请在请求头里带上 Authorization: Bearer <token>",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        payload = jwt.decode(credentials.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录") from None
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="token 无效") from None

    user = db.get_user_by_id(int(payload["sub"]))
    if user is None:
        raise _bad_credentials()
    return user


class RegisterIn(BaseModel):
    email: str = Field(min_length=3, max_length=200, examples=["you@example.com"])
    password: str = Field(min_length=8, max_length=72, examples=["my-password-123"])


class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=1, max_length=72)


class UserOut(BaseModel):
    id: int
    email: str
    created_at: str


class TokenOut(BaseModel):
    token: str
    token_type: str = "bearer"
    user: UserOut


@router.post("/register", response_model=TokenOut, status_code=status.HTTP_201_CREATED)
def register(payload: RegisterIn) -> TokenOut:
    """注册：邮箱 + 至少 8 位密码。成功直接返回 token，省一次登录。"""
    email = payload.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="邮箱格式不对")
    if db.get_user_by_email(email) is not None:
        raise HTTPException(status_code=409, detail="这个邮箱已经注册过了，直接登录吧")

    user = db.create_user(email, hash_password(payload.password))
    return TokenOut(token=create_token(int(user["id"]), email), user=UserOut(**public_user(user)))


@router.post("/login", response_model=TokenOut)
def login(payload: LoginIn) -> TokenOut:
    """登录：邮箱对了但密码不对时，统一回同一句话，不泄露「这个邮箱存在」。"""
    user = db.get_user_by_email(payload.email.strip().lower())
    if user is None or not verify_password(payload.password, str(user["password_hash"])):
        raise _bad_credentials()
    return TokenOut(
        token=create_token(int(user["id"]), str(user["email"])),
        user=UserOut(**public_user(user)),
    )


@router.get("/me", response_model=UserOut)
def me(user: dict[str, Any] = Depends(current_user)) -> UserOut:
    """需要一个有效 token 才能看 —— 这是「登录态」的最小证明。"""
    return UserOut(**public_user(user))
