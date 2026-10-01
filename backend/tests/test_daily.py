import asyncio
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.daily import DailyReader
from backend.settings import Settings


class DailyApiTests(unittest.TestCase):
    def setUp(self):
        temporary = self.enterContext(tempfile.TemporaryDirectory())
        self.settings = Settings(
            data_dir=Path(temporary) / "app",
            daily_database=Path(temporary) / "daily.sqlite3",
            wechat_app_id="test-app", wechat_app_secret="test-secret",
        )
        self.app = create_app(self.settings, start_worker=False)
        self.client = self.enterContext(TestClient(self.app))
        self.store = self.app.state.store
        token = self.store.new_session("daily-user")["access_token"]
        self.headers = {"Authorization": "Bearer " + token}
        self.reader = self.enterContext(patch.object(self.app.state.daily_reader, "read", new_callable=AsyncMock))
        self.reader.return_value = {"ticker": "NVDA", "summary": {}, "history": {}, "lessons": {}}

    def test_requires_login_and_does_not_expose_database(self):
        for path in ("/api/daily", "/api/daily/NVDA"):
            self.assertEqual(self.client.get(path).status_code, 401)
        self.reader.assert_not_awaited()
        response = self.client.get("/api/daily", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["tickers"], ["NVDA", "MSFT", "AAPL"])
        self.assertFalse(response.json()["uses_quota"])
        self.assertNotIn(str(self.settings.daily_database), response.text)

    def test_shared_research_does_not_consume_quota_or_create_jobs(self):
        before = self.store.me("daily-user")["used_today"]
        response = self.client.get("/api/daily/NVDA?before=2026-09-30&lesson_before=10", headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.reader.assert_awaited_once_with("NVDA", "2026-09-30", 10)
        self.assertTrue(response.json()["tracked"])
        self.assertEqual(response.json()["scope"], "shared_research")
        self.assertFalse(response.json()["uses_quota"])
        self.assertEqual(self.store.me("daily-user")["used_today"], before)
        self.assertEqual(self.store.list_jobs("daily-user"), [])
        second = self.store.new_session("another-user")["access_token"]
        self.assertEqual(self.client.get(
            "/api/daily/NVDA", headers={"Authorization": "Bearer " + second}
        ).status_code, 200)

    def test_untracked_stock_is_read_only_not_auto_subscribed(self):
        self.reader.return_value = {"ticker": "TSLA", "summary": {}, "history": {}, "lessons": {}}
        result = self.client.get("/api/daily/TSLA", headers=self.headers)
        self.assertEqual(result.status_code, 200)
        self.assertFalse(result.json()["tracked"])

    def test_invalid_ticker_and_cursors_never_launch_reader(self):
        for suffix in ("0700.HK", "BTC-USD", "NVDA?before=bad", "NVDA?lesson_before=0"):
            with self.subTest(suffix=suffix):
                self.assertEqual(self.client.get("/api/daily/" + suffix, headers=self.headers).status_code, 422)
        self.reader.assert_not_awaited()

    def test_unavailable_or_corrupt_data_is_not_a_success_shaped_empty_result(self):
        for error in (OSError("PRIVATE path"), TimeoutError("PRIVATE"), ValueError("PRIVATE data")):
            with self.subTest(error=type(error).__name__):
                self.reader.side_effect = error
                response = self.client.get("/api/daily/NVDA", headers=self.headers)
                self.assertEqual(response.status_code, 503)
                self.assertNotIn("PRIVATE", response.text)
                self.assertIn("每日复盘数据暂不可用", response.json()["detail"])

    def test_reader_requests_are_rate_limited_without_quota_changes(self):
        for _ in range(20):
            self.assertEqual(self.client.get("/api/daily/NVDA", headers=self.headers).status_code, 200)
        self.assertEqual(self.client.get("/api/daily/NVDA", headers=self.headers).status_code, 429)
        self.assertEqual(self.store.me("daily-user")["used_today"], 0)

    def test_actual_reader_uses_read_only_database_and_shared_metrics(self):
        # The integration uses the installed local project but never contacts providers.
        subprocess.run([
            str(self.settings.tradingagents_python), "-c",
            ("from pathlib import Path; from tradingagents.daily.store import DailyStore; "
             "import sys; DailyStore(Path(sys.argv[1]))"),
            str(self.settings.daily_database),
        ], cwd=self.settings.tradingagents_dir, check=True, capture_output=True, timeout=20)
        original = self.settings.daily_database.read_bytes()
        result = asyncio.run(DailyReader(self.settings).read("NVDA", None, None))
        self.assertEqual(result["summary"]["all"]["scored"], 0)
        self.assertIsNone(result["summary"]["all"]["direction_hit"])
        self.assertEqual(result["history"]["items"], [])
        self.assertEqual(self.settings.daily_database.read_bytes(), original)
        self.assertNotIn(str(self.settings.daily_database), json.dumps(result))


class DailyProcessTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_reader_terminates_its_subprocess(self):
        process = AsyncMock()
        process.returncode = None
        started = asyncio.Event()

        async def communicate():
            started.set()
            await asyncio.Event().wait()

        process.communicate.side_effect = communicate
        with patch("backend.daily.asyncio.create_subprocess_exec", return_value=process), \
                patch("backend.daily.terminate", new_callable=AsyncMock) as terminate:
            task = asyncio.create_task(DailyReader(Settings()).read("NVDA", None, None))
            await started.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            terminate.assert_awaited_once_with(process)

    async def test_bad_reader_output_is_rejected(self):
        process = AsyncMock()
        process.returncode = 0
        with patch("backend.daily.asyncio.create_subprocess_exec", return_value=process), \
                patch("backend.daily.terminate", new_callable=AsyncMock):
            for output in (b"not-json", b"x" * 600_001, b'{"ticker":"MSFT"}'):
                process.communicate.return_value = (output, b"")
                with self.assertRaises(ValueError):
                    await DailyReader(Settings()).read("NVDA", None, None)
