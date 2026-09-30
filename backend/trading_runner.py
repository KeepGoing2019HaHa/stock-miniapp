"""Executed with the existing TradingAgents virtualenv, never with user-supplied code."""

import argparse
import json
import os
import sys
from copy import deepcopy
from pathlib import Path

from dotenv import load_dotenv

DISCLAIMER = "AI 分析基于可获得的数据，可能滞后、缺失或错误，不保证收益，不构成投资建议。"
REPORT_KEYS = {
    "market": "market_report",
    "sentiment": "sentiment_report",
    "news": "news_report",
    "fundamentals": "fundamentals_report",
    "investment_plan": "investment_plan",
    "trader_plan": "trader_investment_plan",
}


def load_tradingagents(project: Path):
    sys.path.insert(0, str(project))
    load_dotenv(project / ".env", override=False)


def normalize_ticker(ticker: str) -> str:
    from tradingagents.dataflows.symbols import crypto_base, normalize_symbol

    normalized = normalize_symbol(ticker)
    if crypto_base(normalized) or "=" in normalized or normalized.startswith("^"):
        raise ValueError("首版只支持股票代码，不支持期货、外汇、加密货币或指数")
    return normalized


def build_result(state: dict, rating: str) -> dict:
    if rating not in {"Buy", "Overweight", "Hold", "Underweight", "Sell", "REVIEW"}:
        raise ValueError(f"Unexpected TradingAgents rating: {rating!r}")
    decision = state.get("final_trade_decision")
    if not isinstance(decision, str) or not decision.strip():
        raise ValueError("TradingAgents returned no final decision")
    reports = {}
    for name, key in REPORT_KEYS.items():
        value = state.get(key, "")
        if not isinstance(value, str):
            raise ValueError(f"Invalid report field: {key}")
        reports[name] = value
    return {
        "rating": rating,
        "final_decision": decision,
        "reports": reports,
        "disclaimer": DISCLAIMER,
    }


def predict(project: Path, ticker: str, analysis_date: str, directory: Path) -> dict:
    load_tradingagents(project)
    from tradingagents.default_config import DEFAULT_CONFIG
    from tradingagents.graph.trading_graph import TradingAgentsGraph

    config = deepcopy(DEFAULT_CONFIG)
    config.update(
        output_language="简体中文",
        results_dir=str(directory / "reports"),
        data_cache_dir=str(directory.parent.parent / "market-cache"),
        # Each user's analysis must not learn from another user's prior runs.
        memory_log_path=str(directory / "memory.md"),
        checkpoint_enabled=False,
    )
    graph = TradingAgentsGraph(debug=False, config=config)
    state, rating = graph.propagate(normalize_ticker(ticker), analysis_date)
    return build_result(state, rating)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--ticker", required=True)
    parser.add_argument("--date")
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--normalize-only", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    load_tradingagents(args.project)
    if args.normalize_only:
        try:
            ticker = normalize_ticker(args.ticker)
        except ValueError as exc:
            print(json.dumps({"error": str(exc)}, ensure_ascii=False))
            raise SystemExit(2) from None
        print(json.dumps({"ticker": ticker}))
        return
    if args.date is None or args.directory is None:
        parser.error("--date and --directory are required for predictions")
    args.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    result = predict(args.project, args.ticker, args.date, args.directory)
    (args.directory / "result.json").write_text(
        json.dumps(result, ensure_ascii=False), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
