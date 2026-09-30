import asyncio
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from backend.models import PredictionRequest
from backend.settings import Settings
from backend.store import Store
from backend.trading_runner import build_result
from backend.worker import MAX_RESULT_BYTES, run_prediction, work


class WorkerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.settings = Settings(data_dir=Path(self.temp.name))
        self.store = Store(self.settings)
        self.store.initialize()
        self.store.new_session("test-user")
        self.request = PredictionRequest(
            ticker="NVDA", analysis_date=date.today().isoformat(), request_id=uuid4()
        )
        self.job, _ = self.store.create_job("test-user", self.request, "NVDA")

    async def wait_finished(self):
        for _ in range(100):
            job = self.store.get_job("test-user", self.job["id"])
            if job["status"] in {"succeeded", "failed"}:
                return job
            await asyncio.sleep(0.01)
        self.fail("Worker did not finish")

    async def exercise(self, mock):
        with patch("backend.worker.run_prediction", mock):
            task = asyncio.create_task(work(self.store, self.settings))
            try:
                return await self.wait_finished()
            finally:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

    async def test_success_shape(self):
        result = build_result({"final_trade_decision": "谨慎持有", "market_report": "行情缺失"}, "Hold")
        job = await self.exercise(AsyncMock(return_value=result))
        self.assertEqual(job["status"], "succeeded")
        self.assertEqual(job["result"]["rating"], "Hold")
        self.assertEqual(
            set(job["result"]["reports"]),
            {"market", "sentiment", "news", "fundamentals", "investment_plan", "trader_plan"},
        )
        self.assertEqual(job["result"]["reports"]["market"], "行情缺失")

    async def test_failure_is_persisted_without_internal_details(self):
        job = await self.exercise(AsyncMock(side_effect=RuntimeError("private credential")))
        self.assertEqual(job["status"], "failed")
        self.assertNotIn("private credential", job["error"])
        self.assertIsNone(job["result"])

    async def test_timeout_is_visible(self):
        job = await self.exercise(AsyncMock(side_effect=TimeoutError))
        self.assertEqual(job["status"], "failed")
        self.assertIn("30 分钟", job["error"])

    async def test_invalid_result_is_visible(self):
        job = await self.exercise(AsyncMock(side_effect=ValueError("size limit")))
        self.assertEqual(job["status"], "failed")
        self.assertIn("显示上限", job["error"])

    async def test_failure_does_not_block_next_user_and_execution_is_serial(self):
        self.store.new_session("next-user")
        next_job, _ = self.store.create_job("next-user", self.request, "NVDA")
        seen = []
        active = 0

        async def prediction(settings, job):
            nonlocal active
            active += 1
            self.assertEqual(active, 1)
            seen.append(job["id"])
            await asyncio.sleep(0.01)
            active -= 1
            if len(seen) == 1:
                raise RuntimeError("first upstream failed")
            return build_result({"final_trade_decision": "请审慎"}, "REVIEW")

        with patch("backend.worker.run_prediction", side_effect=prediction):
            task = asyncio.create_task(work(self.store, self.settings))
            try:
                for _ in range(100):
                    second = self.store.get_job("next-user", next_job["id"])
                    if second["status"] == "succeeded":
                        break
                    await asyncio.sleep(0.01)
                self.assertEqual(second["status"], "succeeded")
            finally:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        self.assertEqual(seen, [self.job["id"], next_job["id"]])
        self.assertEqual(self.store.get_job("test-user", self.job["id"])["status"], "failed")

    async def test_process_timeout_terminates_group(self):
        process = AsyncMock()
        process.pid = 123456
        process.returncode = None
        process.wait.side_effect = [TimeoutError(), None]
        with patch("backend.worker.asyncio.create_subprocess_exec", return_value=process), \
                patch("backend.worker.os.killpg") as kill:
            with self.assertRaises(TimeoutError):
                await run_prediction(self.settings, self.job)
        kill.assert_called_once()
        self.assertEqual(kill.call_args.args[0], process.pid)

    async def test_cancel_kills_process_group(self):
        process = AsyncMock()
        process.pid = 123456
        process.returncode = None
        process.wait.side_effect = [asyncio.CancelledError(), None]
        with patch("backend.worker.asyncio.create_subprocess_exec", return_value=process), \
                patch("backend.worker.os.killpg") as kill:
            with self.assertRaises(asyncio.CancelledError):
                await run_prediction(self.settings, self.job)
        kill.assert_called_once()

    async def test_serialized_result_size_boundary(self):
        directory = self.settings.data_dir / "jobs" / self.job["id"]
        directory.mkdir(parents=True)
        result = build_result({"final_trade_decision": "分析结果"}, "Hold")
        encoded = json.dumps(result, ensure_ascii=False).encode("utf-8")
        process = AsyncMock()
        process.returncode = 0
        with patch("backend.worker.asyncio.create_subprocess_exec", return_value=process):
            for size in (MAX_RESULT_BYTES, MAX_RESULT_BYTES + 1):
                (directory / "result.json").write_bytes(encoded + b" " * (size - len(encoded)))
                if size == MAX_RESULT_BYTES:
                    self.assertEqual(await run_prediction(self.settings, self.job), result)
                else:
                    with self.assertRaisesRegex(ValueError, "size limit"):
                        await run_prediction(self.settings, self.job)

    def test_missing_or_invalid_decision_never_succeeds(self):
        for state, rating in [({}, "Buy"), ({"final_trade_decision": ""}, "Hold"),
                              ({"final_trade_decision": "text"}, "invented")]:
            with self.assertRaises(ValueError):
                build_result(state, rating)

    def test_review_preserves_uncertainty(self):
        self.assertEqual(
            build_result({"final_trade_decision": "数据不足，无法评估"}, "REVIEW")["rating"], "REVIEW"
        )
