"""Opt-in smoke test: real TradingAgents + Copilot; only WeChat identity is mocked."""

import os
import tempfile
import time
import unittest
from dataclasses import replace
from datetime import date
from pathlib import Path
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.settings import Settings


@unittest.skipUnless(os.getenv("RUN_LIVE_PREDICTION") == "1", "Uses real model API quota")
class LivePredictionTests(unittest.TestCase):
    def test_prediction_pipeline(self):
        with tempfile.TemporaryDirectory(prefix="stock-miniapp-live-") as directory:
            settings = replace(Settings.from_env(), data_dir=Path(directory))
            with patch("backend.app.exchange_wechat_code", new_callable=AsyncMock) as login:
                login.return_value = "local-smoke-test-only"
                with TestClient(create_app(settings)) as client:
                    token = client.post("/api/auth/wechat", json={"code": "test-only"}).json()
                    headers = {"Authorization": "Bearer " + token["access_token"]}
                    response = client.post(
                        "/api/predictions",
                        json={"ticker": "NVDA", "analysis_date": date.today().isoformat(),
                              "request_id": str(uuid4())},
                        headers=headers,
                    )
                    self.assertEqual(response.status_code, 202, response.text)
                    job_id = response.json()["id"]
                    deadline = time.monotonic() + settings.prediction_timeout + 30
                    while time.monotonic() < deadline:
                        response = client.get("/api/predictions/" + job_id, headers=headers)
                        self.assertEqual(response.status_code, 200, response.text)
                        job = response.json()
                        if job["status"] in {"succeeded", "failed"}:
                            break
                        time.sleep(5)
                    if job["status"] != "succeeded":
                        log = settings.data_dir / "jobs" / job_id / "worker.log"
                        if log.exists():
                            print(log.read_text(encoding="utf-8")[-6000:])
                    self.assertEqual(job["status"], "succeeded", job["error"])
                    result = job["result"]
                    self.assertIn(result["rating"], {"Buy", "Overweight", "Hold", "Underweight",
                                                    "Sell", "REVIEW"})
                    self.assertTrue(result["final_decision"])
                    self.assertEqual(len(result["reports"]), 6)
                    print(f"Real NVDA pipeline: {job['status']}; rating={result['rating']}; "
                          f"decision_chars={len(result['final_decision'])}", flush=True)
