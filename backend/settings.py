import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Settings:
    data_dir: Path = ROOT / "data"
    tradingagents_dir: Path = ROOT.parent / "TradingAgents"
    tradingagents_python: Path = ROOT.parent / "TradingAgents/.venv/bin/python"
    wechat_app_id: str = ""
    wechat_app_secret: str = ""
    daily_limit: int = 3
    queue_limit: int = 20
    prediction_timeout: int = 1800
    session_seconds: int = 7 * 24 * 3600

    @property
    def wechat_configured(self) -> bool:
        return bool(self.wechat_app_id and self.wechat_app_secret)

    @classmethod
    def from_env(cls):
        load_dotenv(ROOT / ".env", override=False)
        defaults = cls()
        return cls(
            data_dir=Path(os.getenv("DATA_DIR", str(defaults.data_dir))).resolve(),
            tradingagents_dir=Path(
                os.getenv("TRADINGAGENTS_DIR", str(defaults.tradingagents_dir))
            ).resolve(),
            tradingagents_python=Path(
                os.getenv("TRADINGAGENTS_PYTHON", str(defaults.tradingagents_python))
            ).absolute(),
            wechat_app_id=os.getenv("WECHAT_APP_ID", "").strip(),
            wechat_app_secret=os.getenv("WECHAT_APP_SECRET", "").strip(),
        )
