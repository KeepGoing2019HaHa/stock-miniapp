import hashlib
import json
import secrets
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import HTTPException

from .models import analysis_date_max, quota_date
from .settings import Settings


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Store:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.path = settings.data_dir / "app.sqlite3"

    @contextmanager
    def connection(self, *, write=False):
        with sqlite3.connect(self.path, timeout=10) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            if write:
                db.execute("BEGIN IMMEDIATE")
            yield db

    def initialize(self):
        self.settings.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.settings.data_dir.chmod(0o700)
        with self.connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id),
                    expires_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id),
                    request_id TEXT NOT NULL,
                    ticker TEXT NOT NULL,
                    analysis_date TEXT NOT NULL,
                    quota_date TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    started_at TEXT,
                    finished_at TEXT,
                    error TEXT,
                    result TEXT,
                    UNIQUE(user_id, request_id)
                );
                CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(user_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS jobs_quota ON jobs(user_id, quota_date);
                CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created_at);
            """)
        self.path.chmod(0o600)

    def recover(self):
        with self.connection(write=True) as db:
            db.execute(
                "UPDATE jobs SET status='failed', error=?, finished_at=? WHERE status='running'",
                ("服务重启中断了本次分析，请重新提交；本次仍计入当日额度。", utc_now()),
            )

    def new_session(self, user_id: str) -> dict:
        token = secrets.token_urlsafe(32)
        expires = int(time.time()) + self.settings.session_seconds
        with self.connection(write=True) as db:
            db.execute("INSERT OR IGNORE INTO users VALUES (?, ?)", (user_id, utc_now()))
            db.execute("DELETE FROM sessions WHERE expires_at <= ?", (int(time.time()),))
            # A fresh login replaces older sessions for the same WeChat identity.
            db.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
            db.execute("INSERT INTO sessions VALUES (?, ?, ?)", (token_hash(token), user_id, expires))
        return {
            "access_token": token,
            "expires_at": datetime.fromtimestamp(expires, timezone.utc).isoformat(),
        }

    def authenticate(self, token: str) -> str:
        with self.connection() as db:
            row = db.execute(
                "SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?",
                (token_hash(token), int(time.time())),
            ).fetchone()
        if row is None:
            raise HTTPException(401, "登录已过期，请重新微信登录")
        return row["user_id"]

    def revoke(self, token: str):
        with self.connection(write=True) as db:
            db.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash(token),))

    def me(self, user_id: str) -> dict:
        day = quota_date()
        with self.connection() as db:
            used = db.execute(
                "SELECT COUNT(*) FROM jobs WHERE user_id=? AND quota_date=?", (user_id, day)
            ).fetchone()[0]
        return {
            "daily_limit": self.settings.daily_limit,
            "used_today": used,
            "remaining_today": max(0, self.settings.daily_limit - used),
            "quota_date": day,
            "analysis_date_max": analysis_date_max(),
            "timezone": "Asia/Shanghai",
        }

    @staticmethod
    def public_job(row, *, detail=False) -> dict:
        fields = (
            "id", "ticker", "analysis_date", "status", "created_at",
            "started_at", "finished_at", "error",
        )
        job = {key: row[key] for key in fields}
        if detail:
            job["result"] = json.loads(row["result"]) if row["result"] else None
        return job

    def create_job(self, user_id: str, request, ticker: str) -> tuple[dict, bool]:
        day = quota_date()
        with self.connection(write=True) as db:
            previous = db.execute(
                "SELECT * FROM jobs WHERE user_id=? AND request_id=?",
                (user_id, str(request.request_id)),
            ).fetchone()
            if previous:
                if previous["ticker"] != ticker or previous["analysis_date"] != request.analysis_date:
                    raise HTTPException(409, "此请求编号已用于其他参数，请创建新的请求")
                return self.public_job(previous), False
            if db.execute(
                "SELECT 1 FROM jobs WHERE user_id=? AND status IN ('queued','running')",
                (user_id,),
            ).fetchone():
                raise HTTPException(409, "你已有排队或分析中的任务，请在历史记录中查看")
            used = db.execute(
                "SELECT COUNT(*) FROM jobs WHERE user_id=? AND quota_date=?", (user_id, day)
            ).fetchone()[0]
            if used >= self.settings.daily_limit:
                raise HTTPException(429, "今日 3 次额度已用完，北京时间零点重置")
            queued = db.execute(
                "SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')"
            ).fetchone()[0]
            if queued >= self.settings.queue_limit:
                raise HTTPException(503, "当前预测队列已满，请稍后重试，本次未扣额度")
            job_id = str(uuid4())
            db.execute(
                """INSERT INTO jobs
                   (id,user_id,request_id,ticker,analysis_date,quota_date,status,created_at)
                   VALUES (?,?,?,?,?,?,'queued',?)""",
                (job_id, user_id, str(request.request_id), ticker, request.analysis_date, day, utc_now()),
            )
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            return self.public_job(row), True

    def list_jobs(self, user_id: str) -> list[dict]:
        with self.connection() as db:
            rows = db.execute(
                "SELECT * FROM jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 20", (user_id,)
            ).fetchall()
        return [self.public_job(row) for row in rows]

    def get_job(self, user_id: str, job_id: str) -> dict:
        with self.connection() as db:
            row = db.execute(
                "SELECT * FROM jobs WHERE id=? AND user_id=?", (job_id, user_id)
            ).fetchone()
        if row is None:
            raise HTTPException(404, "任务不存在或无权访问")
        return self.public_job(row, detail=True)

    def claim(self) -> dict | None:
        with self.connection(write=True) as db:
            row = db.execute(
                "SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            db.execute(
                "UPDATE jobs SET status='running', started_at=? WHERE id=?", (utc_now(), row["id"])
            )
            return dict(row)

    def finish(self, job_id: str, *, result=None, error=None):
        with self.connection(write=True) as db:
            db.execute(
                "UPDATE jobs SET status=?, result=?, error=?, finished_at=? WHERE id=?",
                (
                    "failed" if error else "succeeded",
                    json.dumps(result, ensure_ascii=False) if result is not None else None,
                    error, utc_now(), job_id,
                ),
            )
