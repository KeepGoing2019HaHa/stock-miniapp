import asyncio
import fcntl
import hashlib
import logging
import time
from collections import OrderedDict
from contextlib import asynccontextmanager
from datetime import date
from typing import Annotated
from uuid import UUID

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from . import worker
from .daily import DailyReader
from .models import DailyQuery, LoginRequest, PredictionRequest
from .settings import Settings
from .store import Store

logger = logging.getLogger(__name__)
bearer = HTTPBearer(auto_error=False)


class BodyLimitMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in {"POST", "PUT", "PATCH"}:
            return await self.app(scope, receive, send)
        chunks = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunks.extend(message.get("body", b""))
            if len(chunks) > 8192:
                response = JSONResponse(status_code=413, content={"detail": "请求内容过大"})
                return await response(scope, receive, send)
            if not message.get("more_body", False):
                break
        delivered = False

        async def limited_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(chunks), "more_body": False}
            return await receive()

        await self.app(scope, limited_receive, send)


class RateLimiter:
    def __init__(self):
        self.buckets = OrderedDict()

    def check(self, key: str, limit: int, seconds=60):
        now = time.monotonic()
        start, count = self.buckets.pop(key, (now, 0))
        if now - start >= seconds:
            start, count = now, 0
        self.buckets[key] = (start, count + 1)
        if len(self.buckets) > 10000:
            self.buckets.popitem(last=False)
        if count >= limit:
            raise HTTPException(429, "请求过于频繁，请稍后再试", headers={"Retry-After": str(seconds)})


async def exchange_wechat_code(settings: Settings, client: httpx.AsyncClient, code: str) -> str:
    if not settings.wechat_configured:
        raise HTTPException(503, "微信登录尚未配置，请联系管理员")
    try:
        response = await client.get(
            "https://api.weixin.qq.com/sns/jscode2session",
            params={
                "appid": settings.wechat_app_id,
                "secret": settings.wechat_app_secret,
                "js_code": code,
                "grant_type": "authorization_code",
            },
        )
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        # HTTP exception strings can contain the AppSecret-bearing request URL.
        logger.warning("WeChat exchange unavailable: %s", type(exc).__name__)
        raise HTTPException(502, "微信登录服务暂时不可用，请稍后重试") from None
    if not isinstance(payload, dict):
        logger.error("WeChat returned a non-object response")
        raise HTTPException(502, "微信登录服务返回异常")
    code = payload.get("errcode", 0)
    if code in (40029, 40163):
        raise HTTPException(401, "微信登录凭证失效，请重新登录")
    if code:
        logger.warning("WeChat exchange failed with error code %s", code)
        raise HTTPException(502, "微信登录失败，请稍后重试或联系管理员")
    openid = payload.get("openid")
    if not isinstance(openid, str) or not openid:
        logger.error("WeChat response missing openid")
        raise HTTPException(502, "微信登录服务返回异常")
    # Do not persist raw openid, session_key, or the short-lived login code.
    return hashlib.sha256(f"{settings.wechat_app_id}:{openid}".encode()).hexdigest()


def create_app(settings: Settings | None = None, *, start_worker=True) -> FastAPI:
    settings = settings or Settings.from_env()
    store = Store(settings)
    limiter = RateLimiter()
    daily_reader = DailyReader(settings)

    @asynccontextmanager
    async def lifespan(app):
        settings.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (settings.data_dir / "service.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RuntimeError("Only one API/worker process may use this DATA_DIR") from exc
            store.initialize()
            store.recover()
            async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
                app.state.wechat_client = client
                task = asyncio.create_task(worker.work(store, settings)) if start_worker else None
                app.state.worker_task = task
                try:
                    yield
                finally:
                    if task:
                        task.cancel()
                        try:
                            await task
                        except asyncio.CancelledError:
                            pass

    app = FastAPI(title="股票研究助手 API", lifespan=lifespan, docs_url=None, redoc_url=None,
                  openapi_url=None)
    app.state.store = store
    app.state.settings = settings
    app.state.limiter = limiter
    app.state.daily_reader = daily_reader
    app.add_middleware(BodyLimitMiddleware)

    @app.exception_handler(Exception)
    async def unexpected_error(request, exc):
        logger.error("Unhandled API error", exc_info=(type(exc), exc, exc.__traceback__))
        return JSONResponse(status_code=500, content={"detail": "服务内部异常，请联系管理员"})

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        messages = []
        for error in exc.errors():
            field = ".".join(str(item) for item in error["loc"][1:])
            messages.append(f"{field}: {error['msg']}")
        return JSONResponse(status_code=422, content={"detail": "；".join(messages)})

    @app.middleware("http")
    async def rate_limit(request: Request, call_next):
        if request.url.path.startswith("/api/"):
            key = request.client.host if request.client else "unknown"
            try:
                limiter.check("ip:" + key, 120)
                if request.url.path == "/api/auth/wechat":
                    limiter.check("login:global", 120)
                    limiter.check("login:" + key, 10)
            except HTTPException as exc:
                return JSONResponse(
                    status_code=exc.status_code, content={"detail": exc.detail}, headers=exc.headers
                )
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    def credentials(auth: HTTPAuthorizationCredentials | None = Depends(bearer)) -> str:
        if auth is None or len(auth.credentials) > 128:
            raise HTTPException(401, "请先微信登录")
        return auth.credentials

    def user_id(token: str = Depends(credentials)) -> str:
        return store.authenticate(token)

    def ensure_worker():
        task = app.state.worker_task
        if start_worker and (task is None or task.done()):
            logger.error("Prediction worker is unavailable")
            raise HTTPException(503, "预测服务暂不可用，请联系管理员")
        if not settings.tradingagents_python.is_file() or not settings.tradingagents_dir.is_dir():
            raise HTTPException(503, "预测运行环境未配置，请联系管理员")

    @app.get("/health")
    def health(response: Response):
        task = app.state.worker_task
        runtime = settings.tradingagents_python.is_file() and settings.tradingagents_dir.is_dir()
        ready = settings.wechat_configured and runtime and bool(task and not task.done())
        response.status_code = 200 if ready else 503
        return {
            "status": "ready" if ready else "not_ready",
            "wechat_configured": settings.wechat_configured,
            "tradingagents_configured": runtime,
            "worker_running": bool(task and not task.done()),
        }

    @app.post("/api/auth/wechat")
    async def login(body: LoginRequest):
        identity = await exchange_wechat_code(settings, app.state.wechat_client, body.code)
        return await asyncio.to_thread(store.new_session, identity)

    @app.delete("/api/session", status_code=204)
    def logout(token: str = Depends(credentials), identity: str = Depends(user_id)):
        store.revoke(token)
        return Response(status_code=204)

    @app.get("/api/me")
    def me(identity: str = Depends(user_id)):
        return store.me(identity)

    @app.post("/api/predictions")
    async def create_prediction(
        body: PredictionRequest, response: Response, identity: str = Depends(user_id)
    ):
        ensure_worker()
        limiter.check("submit:" + identity, 10)
        try:
            ticker = await worker.normalize_ticker(settings, body.ticker)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None
        except (OSError, TimeoutError):
            logger.exception("Ticker normalization unavailable")
            raise HTTPException(503, "预测运行环境暂不可用，请联系管理员") from None
        job, created = await asyncio.to_thread(store.create_job, identity, body, ticker)
        response.status_code = 202 if created else 200
        return job

    @app.get("/api/predictions")
    def list_predictions(identity: str = Depends(user_id)):
        return {"items": store.list_jobs(identity)}

    @app.get("/api/predictions/{job_id}")
    def get_prediction(job_id: UUID, identity: str = Depends(user_id)):
        return store.get_job(identity, str(job_id))

    @app.get("/api/daily")
    def daily_catalog(identity: str = Depends(user_id)):
        return {"tickers": list(settings.daily_tickers), "scope": "shared_research", "uses_quota": False}

    @app.get("/api/evolution")
    async def evolution_research(before: date | None = None, identity: str = Depends(user_id)):
        limiter.check("evolution:" + identity, 20)
        try:
            data = await daily_reader.read("MSFT", before.isoformat() if before else None, None, evolution=True)
        except (OSError, TimeoutError, ValueError):
            logger.exception("Evolution research data unavailable")
            raise HTTPException(503, "进化记录暂不可用，请稍后重试") from None
        return {**data, "scope": "shared_research", "uses_quota": False}

    @app.get("/api/daily/{ticker}")
    async def daily_research(query: Annotated[DailyQuery, Depends()], identity: str = Depends(user_id)):
        limiter.check("daily:" + identity, 20)
        try:
            data = await daily_reader.read(
                query.ticker, query.before.isoformat() if query.before else None, query.lesson_before,
            )
        except (OSError, TimeoutError, ValueError):
            logger.exception("Daily research data unavailable")
            raise HTTPException(503, "每日复盘数据暂不可用，请稍后重试或联系管理员") from None
        return {**data, "tracked": query.ticker in settings.daily_tickers,
                "scope": "shared_research", "uses_quota": False}

    return app


app = create_app()
