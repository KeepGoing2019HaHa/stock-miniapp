import asyncio
import json
import logging
from pathlib import Path

from .settings import Settings
from .worker import runner_environment, terminate

logger = logging.getLogger(__name__)
RUNNER = Path(__file__).with_name("daily_runner.py")


class DailyReader:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.slots = asyncio.Semaphore(2)

    async def read(self, ticker: str, before: str | None, lesson_before: int | None, *, evolution: bool = False) -> dict:
        async with asyncio.timeout(20):
            async with self.slots:
                args = [
                    str(self.settings.tradingagents_python), str(RUNNER),
                    "--project", str(self.settings.tradingagents_dir),
                    "--database", str(self.settings.daily_database), "--ticker", ticker,
                ]
                if before:
                    args.extend(["--before", before])
                if lesson_before is not None:
                    args.extend(["--lesson-before", str(lesson_before)])
                if evolution:
                    args.append("--evolution")
                process = await asyncio.create_subprocess_exec(
                    *args, cwd=self.settings.tradingagents_dir,
                    env=runner_environment(), start_new_session=True,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                )
                try:
                    stdout, _ = await process.communicate()
                finally:
                    await terminate(process)
        if process.returncode:
            logger.warning("Daily research reader failed (exit %s)", process.returncode)
            raise OSError("Daily reader failed")
        if len(stdout) > 600_000:
            raise ValueError("Oversized daily dashboard")
        data = json.loads(stdout)
        required = ("summary", "history") if evolution else ("summary", "history", "lessons")
        if (not isinstance(data, dict) or data.get("ticker") != ticker
            or not all(isinstance(data.get(key), dict) for key in required)):
            raise ValueError("Invalid daily dashboard")
        return data
