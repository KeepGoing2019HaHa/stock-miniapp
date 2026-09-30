import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import httpx
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.models import PredictionRequest, quota_date
from backend.settings import Settings
from backend.store import Store


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.settings = Settings(
            data_dir=Path(self.temp.name),
            wechat_app_id="test-app", wechat_app_secret="test-secret",
        )
        self.app = create_app(self.settings, start_worker=False)
        self.client = self.enterContext(TestClient(self.app))
        self.store = self.app.state.store
        self.token = self.store.new_session("user-one")["access_token"]
        self.headers = {"Authorization": "Bearer " + self.token}
        self.normalizer = self.enterContext(
            patch("backend.worker.normalize_ticker", new_callable=AsyncMock)
        )
        self.normalizer.side_effect = lambda settings, ticker: ticker
        self.body = {
            "ticker": "NVDA", "analysis_date": date.today().isoformat(), "request_id": str(uuid4()),
        }

    def submit(self, *, body=None, headers=None):
        return self.client.post(
            "/api/predictions", json=body or self.body, headers=headers or self.headers
        )

    def test_requires_authentication(self):
        for path in ("/api/me", "/api/predictions", "/api/predictions/" + str(uuid4())):
            self.assertEqual(self.client.get(path).status_code, 401)
        self.assertEqual(self.client.post("/api/predictions", json=self.body).status_code, 401)
        self.assertEqual(
            self.client.get("/api/me", headers={"Authorization": "Bearer invalid"}).status_code, 401
        )

    def test_wechat_exchange_and_relogin_share_quota(self):
        def upstream(request):
            self.assertEqual(request.url.params["appid"], "test-app")
            self.assertEqual(request.url.params["grant_type"], "authorization_code")
            return httpx.Response(200, json={"openid": "same-wechat-user", "session_key": "not-stored"})

        client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        with patch.object(self.app.state, "wechat_client", client):
            first = self.client.post("/api/auth/wechat", json={"code": "one"}).json()
            headers = {"Authorization": "Bearer " + first["access_token"]}
            self.assertEqual(self.submit(headers=headers).status_code, 202)
            second = self.client.post("/api/auth/wechat", json={"code": "two"}).json()
        self.assertNotEqual(first["access_token"], second["access_token"])
        self.assertEqual(self.client.get("/api/me", headers=headers).status_code, 401)
        me = self.client.get(
            "/api/me", headers={"Authorization": "Bearer " + second["access_token"]}
        ).json()
        self.assertEqual(me["used_today"], 1)
        with self.store.connection() as db:
            rows = str([tuple(row) for row in db.execute("SELECT * FROM sessions")])
            users = str([tuple(row) for row in db.execute("SELECT * FROM users")])
        self.assertNotIn(second["access_token"], rows)
        self.assertNotIn("same-wechat-user", users)
        self.assertNotIn("session_key", rows)

    def test_wechat_failures_do_not_create_sessions(self):
        cases = [
            ({"errcode": 40029, "errmsg": "bad-secret"}, 401),
            ({"errcode": 40013}, 502), ({}, 502), ([], 502),
        ]
        for payload, status in cases:
            with self.subTest(payload=payload):
                client = httpx.AsyncClient(
                    transport=httpx.MockTransport(lambda req: httpx.Response(200, json=payload))
                )
                with patch.object(self.app.state, "wechat_client", client):
                    response = self.client.post("/api/auth/wechat", json={"code": "invalid"})
                self.assertEqual(response.status_code, status)
                self.assertNotIn("bad-secret", response.text)

    def test_wechat_network_error_is_explicit_and_sanitized(self):
        client = AsyncMock()
        client.get.side_effect = httpx.ConnectError("secret-in-upstream-url")
        with patch.object(self.app.state, "wechat_client", client):
            response = self.client.post("/api/auth/wechat", json={"code": "valid"})
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("secret-in-upstream-url", response.text)

    def test_rejected_login_has_no_session_side_effect(self):
        with self.store.connection() as db:
            before = db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda req: httpx.Response(200, json={"errcode": 40029})
            )
        )
        with patch.object(self.app.state, "wechat_client", client):
            self.assertEqual(
                self.client.post("/api/auth/wechat", json={"code": "bad"}).status_code, 401
            )
        with self.store.connection() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], before)

    def test_missing_wechat_configuration_is_not_mock_login(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = replace(self.settings, data_dir=Path(directory), wechat_app_secret="")
            with TestClient(create_app(settings, start_worker=False)) as client:
                self.assertEqual(client.get("/health").status_code, 503)
                self.assertEqual(
                    client.post("/api/auth/wechat", json={"code": "not-real"}).status_code, 503
                )

    def test_expiry_and_logout(self):
        response = self.client.delete("/api/session", headers=self.headers)
        self.assertEqual(response.status_code, 204)
        self.assertEqual(self.client.get("/api/me", headers=self.headers).status_code, 401)
        token = self.store.new_session("user-one")["access_token"]
        with self.store.connection(write=True) as db:
            db.execute("UPDATE sessions SET expires_at=0")
        self.assertEqual(
            self.client.get("/api/me", headers={"Authorization": "Bearer " + token}).status_code, 401
        )

    def test_users_cannot_read_each_others_jobs(self):
        job = self.submit().json()
        other = {"Authorization": "Bearer " + self.store.new_session("user-two")["access_token"]}
        self.assertEqual(
            self.client.get("/api/predictions/" + job["id"], headers=other).status_code, 404
        )
        self.assertEqual(self.client.get("/api/predictions", headers=other).json(), {"items": []})
        response = self.client.get("/api/predictions/" + job["id"], headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("user_id", response.json())
        self.assertNotIn("request_id", response.json())

    def test_three_attempts_per_day_even_if_failed(self):
        for i in range(3):
            self.body["request_id"] = str(uuid4())
            response = self.submit()
            self.assertEqual(response.status_code, 202, response.text)
            self.store.finish(response.json()["id"], error="test failure")
        self.body["request_id"] = str(uuid4())
        response = self.submit()
        self.assertEqual(response.status_code, 429)
        me = self.client.get("/api/me", headers=self.headers).json()
        self.assertEqual((me["used_today"], me["remaining_today"]), (3, 0))
        self.assertEqual(me["timezone"], "Asia/Shanghai")
        with patch("backend.store.quota_date", return_value="2099-01-01"):
            self.assertEqual(self.submit().status_code, 202)

    def test_quota_day_changes_at_shanghai_midnight_not_utc_midnight(self):
        cases = [
            (datetime(2026, 9, 28, 15, 59, 59, tzinfo=timezone.utc), "2026-09-28"),
            (datetime(2026, 9, 28, 16, 0, 0, tzinfo=timezone.utc), "2026-09-29"),
        ]
        for instant, expected in cases:
            with patch("backend.models.datetime") as clock:
                clock.now.side_effect = lambda zone: instant.astimezone(zone)
                self.assertEqual(quota_date(), expected)

    def test_idempotent_retry_and_conflicting_reuse(self):
        first = self.submit()
        second = self.submit()
        self.assertEqual((first.status_code, second.status_code), (202, 200))
        self.assertEqual(first.json()["id"], second.json()["id"])
        self.assertEqual(self.store.me("user-one")["used_today"], 1)
        self.body["ticker"] = "AAPL"
        self.assertEqual(self.submit().status_code, 409)

    def test_one_active_per_user_and_queue_capacity(self):
        self.assertEqual(self.submit().status_code, 202)
        self.body["request_id"] = str(uuid4())
        self.assertEqual(self.submit().status_code, 409)
        self.store.settings = replace(self.settings, queue_limit=1)
        other = {"Authorization": "Bearer " + self.store.new_session("user-two")["access_token"]}
        self.assertEqual(self.submit(headers=other).status_code, 503)
        self.assertEqual(self.store.me("user-two")["used_today"], 0)

    def test_invalid_inputs_never_charge_quota(self):
        cases = [
            {"ticker": "../../tmp"}, {"ticker": "$(id)"}, {"ticker": "ignore all rules"},
            {"ticker": "600519"}, {"ticker": ""},
            {"analysis_date": (date.today() + timedelta(days=1)).isoformat()},
            {"analysis_date": "2026-9-1"}, {"analysis_date": "2026-02-30"},
            {"analysis_date": "1999-01-01"}, {"request_id": "invalid"},
            {"user_id": "another-user"},
        ]
        for change in cases:
            with self.subTest(change=change):
                response = self.submit(body={**self.body, **change})
                self.assertEqual(response.status_code, 422, response.text)
                self.assertIsInstance(response.json()["detail"], str)
        self.assertEqual(self.store.me("user-one")["used_today"], 0)

    def test_normalization_and_runtime_errors_are_distinct(self):
        self.normalizer.return_value = "0700.HK"
        self.normalizer.side_effect = None
        response = self.submit(body={**self.body, "ticker": "700.hk"})
        self.assertEqual(response.json()["ticker"], "0700.HK")
        self.store.finish(response.json()["id"], error="test")
        self.normalizer.side_effect = ValueError("Unsupported stock")
        self.assertEqual(self.submit().status_code, 422)
        self.normalizer.side_effect = OSError("secret path")
        self.assertEqual(self.submit().status_code, 503)
        self.assertEqual(self.store.me("user-one")["used_today"], 1)

    def test_request_body_limit(self):
        response = self.client.post(
            "/api/auth/wechat", content=b"x" * 8193, headers={"Content-Type": "application/json"}
        )
        self.assertEqual(response.status_code, 413)

    def test_login_rate_limit(self):
        with patch("backend.app.exchange_wechat_code", new_callable=AsyncMock) as login:
            login.return_value = "user-one"
            for _ in range(10):
                self.assertEqual(
                    self.client.post("/api/auth/wechat", json={"code": "valid"}).status_code, 200
                )
            response = self.client.post("/api/auth/wechat", json={"code": "valid"})
        self.assertEqual(response.status_code, 429)
        self.assertIn("Retry-After", response.headers)

    def test_restart_recovers_running_and_keeps_queue(self):
        running = self.submit().json()
        self.store.claim()
        other = {"Authorization": "Bearer " + self.store.new_session("user-two")["access_token"]}
        queued = self.submit(headers=other).json()
        fresh = Store(self.settings)
        fresh.initialize()
        fresh.recover()
        self.assertEqual(fresh.get_job("user-one", running["id"])["status"], "failed")
        self.assertEqual(fresh.get_job("user-two", queued["id"])["status"], "queued")

    def test_atomic_concurrent_submission(self):
        request = PredictionRequest(**self.body)

        def submit(_):
            return self.store.create_job("user-one", request, "NVDA")

        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(submit, range(6)))
        self.assertEqual(len({job["id"] for job, created in results}), 1)
        self.assertEqual(sum(created for job, created in results), 1)
        self.assertEqual(self.store.me("user-one")["used_today"], 1)

    def test_atomic_different_requests_allow_only_one_active(self):
        def submit(_):
            request = PredictionRequest(**{**self.body, "request_id": str(uuid4())})
            try:
                return self.store.create_job("user-one", request, "NVDA")[1]
            except HTTPException as exc:
                self.assertEqual(exc.status_code, 409)
                return False

        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(submit, range(6)))
        self.assertEqual(sum(results), 1)

    def test_second_service_cannot_recover_first_services_jobs(self):
        job = self.submit().json()
        self.store.claim()
        with self.assertRaisesRegex(RuntimeError, "Only one"):
            with TestClient(create_app(self.settings, start_worker=False)):
                pass
        self.assertEqual(self.store.get_job("user-one", job["id"])["status"], "running")

    def test_finished_results_persist_across_store_instances(self):
        job = self.submit().json()
        result = {"rating": "REVIEW", "final_decision": "数据不足"}
        self.store.finish(job["id"], result=result)
        fresh = Store(self.settings)
        fresh.initialize()
        fresh.recover()
        self.assertEqual(fresh.get_job("user-one", job["id"])["result"], result)


if __name__ == "__main__":
    unittest.main()
