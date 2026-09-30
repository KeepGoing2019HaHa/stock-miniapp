import re
from datetime import date, datetime
from uuid import UUID
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, field_validator

QUOTA_TIMEZONE = ZoneInfo("Asia/Shanghai")
STOCK_PATTERN = re.compile(r"(?:[A-Z]{1,10}(?:[.-][A-Z]{1,3})?|[0-9]{1,5}\.HK|[0-9]{6}\.(?:SS|SH|SZ))")


def quota_date() -> str:
    return datetime.now(QUOTA_TIMEZONE).date().isoformat()


def analysis_date_max() -> str:
    # TradingAgents compares against the local date of its Python process.
    return date.today().isoformat()


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(min_length=1, max_length=256, pattern=r"^[A-Za-z0-9_-]+$")


class PredictionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ticker: str = Field(min_length=1, max_length=20)
    analysis_date: str
    request_id: UUID

    @field_validator("ticker")
    @classmethod
    def validate_ticker(cls, value: str) -> str:
        value = value.strip().upper()
        if not STOCK_PATTERN.fullmatch(value):
            raise ValueError("请输入股票代码，如 NVDA、0700.HK、600519.SS 或 000001.SZ")
        return value

    @field_validator("analysis_date")
    @classmethod
    def validate_date(cls, value: str) -> str:
        try:
            parsed = date.fromisoformat(value)
        except ValueError as exc:
            raise ValueError("分析日期格式必须为 YYYY-MM-DD") from exc
        if parsed.isoformat() != value or value > analysis_date_max() or parsed.year < 2000:
            raise ValueError("分析日期须在 2000-01-01 与服务器今天之间")
        return value
