import asyncio
import json
import logging
import os
import signal
from pathlib import Path

from .settings import Settings
from .store import Store

logger = logging.getLogger(__name__)
RUNNER = Path(__file__).with_name("trading_runner.py")
MAX_RESULT_BYTES = 800_000


def runner_environment() -> dict[str, str]:
    # WeChat credentials are not needed by the analysis subprocess.
    return {key: value for key, value in os.environ.items() if not key.startswith("WECHAT_")}


async def terminate(process):
    if process.returncode is None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass  # The process finished between returncode and killpg.
        await process.wait()


async def normalize_ticker(settings: Settings, ticker: str) -> str:
    process = await asyncio.create_subprocess_exec(
        str(settings.tradingagents_python), str(RUNNER),
        "--project", str(settings.tradingagents_dir), "--ticker", ticker, "--normalize-only",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        cwd=settings.tradingagents_dir, env=runner_environment(), start_new_session=True,
    )
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=15)
    finally:
        await terminate(process)
    if process.returncode == 2:
        raise ValueError("股票代码不受支持，请使用美股、港股或 A 股代码")
    if process.returncode:
        # Do not expose stderr, local paths, or upstream configuration to clients.
        logger.warning("Ticker normalization rejected request (exit %s)", process.returncode)
        raise OSError("TradingAgents normalization subprocess failed")
    return json.loads(stdout)["ticker"]


async def run_prediction(settings: Settings, job: dict) -> dict:
    directory = settings.data_dir / "jobs" / job["id"]
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / "worker.log").open("wb") as log:
        process = await asyncio.create_subprocess_exec(
            str(settings.tradingagents_python), str(RUNNER),
            "--project", str(settings.tradingagents_dir),
            "--ticker", job["ticker"], "--date", job["analysis_date"],
            "--directory", str(directory),
            cwd=settings.tradingagents_dir, env=runner_environment(),
            stdout=log, stderr=asyncio.subprocess.STDOUT, start_new_session=True,
        )
        try:
            await asyncio.wait_for(process.wait(), timeout=settings.prediction_timeout)
            if process.returncode:
                raise RuntimeError(f"TradingAgents exited with status {process.returncode}")
        finally:
            await terminate(process)
    result_path = directory / "result.json"
    # Leave room for page metadata below WeChat's 1 MiB setData limit.
    if result_path.stat().st_size > MAX_RESULT_BYTES:
        raise ValueError("Analysis result exceeds size limit")
    result = json.loads(result_path.read_text(encoding="utf-8"))
    if not isinstance(result, dict) or not result.get("final_decision") or not result.get("rating"):
        raise ValueError("Analysis result is incomplete")
    return result


async def work(store: Store, settings: Settings):
    while True:
        job = await asyncio.to_thread(store.claim)
        if job is None:
            await asyncio.sleep(1)
            continue
        try:
            result = await run_prediction(settings, job)
        except asyncio.CancelledError:
            await asyncio.to_thread(
                store.finish, job["id"], error="服务停止中断了本次分析，请重新提交。"
            )
            raise
        except TimeoutError:
            logger.warning("Prediction %s timed out", job["id"])
            await asyncio.to_thread(
                store.finish, job["id"], error="分析超过 30 分钟已终止，请稍后重新提交。"
            )
        except ValueError:
            logger.exception("Prediction %s returned an invalid or oversized result", job["id"])
            await asyncio.to_thread(
                store.finish, job["id"],
                error="分析结果格式异常或超过小程序显示上限，请联系管理员凭任务编号排查。",
            )
        except Exception:
            # Job boundary: persist failure and keep processing other users' jobs.
            logger.exception("Prediction %s failed", job["id"])
            await asyncio.to_thread(
                store.finish, job["id"],
                error="分析失败，可能是行情数据或模型服务不可用。请稍后重试；管理员可凭任务编号排查。",
            )
        else:
            await asyncio.to_thread(store.finish, job["id"], result=result)
