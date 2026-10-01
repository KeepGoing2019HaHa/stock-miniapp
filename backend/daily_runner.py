"""Read public daily research using TradingAgents' interpreter and metric logic."""

import argparse
import json
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--ticker", required=True)
    parser.add_argument("--before")
    parser.add_argument("--lesson-before", type=int)
    args = parser.parse_args()
    sys.path.insert(0, str(args.project))
    from tradingagents.daily.dashboard import snapshot
    from tradingagents.daily.store import DailyStore

    result = snapshot(
        DailyStore(args.database, read_only=True), args.ticker,
        before=args.before, lesson_before=args.lesson_before,
    )
    text = json.dumps(result, ensure_ascii=False, allow_nan=False)
    if len(text.encode("utf-8")) > 600_000:
        raise ValueError("Daily dashboard exceeds response size limit")
    print(text)


if __name__ == "__main__":
    main()
