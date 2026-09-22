#!/usr/bin/env python3
"""One-off pull of descriptive fundamentals from Yahoo Finance for the IDX universe.
Output: JSON list, one object per symbol, written incrementally (resumable) so a
mid-run failure doesn't lose progress. No credentials -- yfinance's unofficial
public endpoint, so this is best-effort and rate-limit-throttled."""
import json
import sys
import time
import random

import yfinance as yf

FIELDS = [
    "sector", "industry", "trailingPE", "forwardPE", "priceToBook",
    "revenueGrowth", "earningsGrowth", "earningsQuarterlyGrowth",
    "returnOnEquity", "dividendYield", "marketCap", "beta",
    "targetMeanPrice", "recommendationKey", "profitMargins"
]

def main():
    symbols_file, out_file = sys.argv[1], sys.argv[2]
    with open(symbols_file) as f:
        symbols = [s.strip() for s in f if s.strip()]

    done = {}
    try:
        with open(out_file) as f:
            for row in json.load(f):
                done[row["symbol"]] = row
    except FileNotFoundError:
        pass

    for i, sym in enumerate(symbols):
        if sym in done and "error" not in done[sym]:
            continue
        ticker = f"{sym}.JK"
        for attempt in range(3):
            try:
                info = yf.Ticker(ticker).info
                row = {"symbol": sym, "ticker": ticker}
                for k in FIELDS:
                    row[k] = info.get(k)
                done[sym] = row
                print(f"[{i+1}/{len(symbols)}] {sym} ok (sector={row.get('sector')})", flush=True)
                break
            except Exception as e:
                wait = 3 * (attempt + 1) + random.random() * 2
                print(f"[{i+1}/{len(symbols)}] {sym} attempt {attempt+1} failed: {e} -- retrying in {wait:.1f}s", flush=True)
                time.sleep(wait)
        else:
            done[sym] = {"symbol": sym, "ticker": ticker, "error": "failed after 3 attempts"}

        if (i + 1) % 5 == 0:
            with open(out_file, "w") as f:
                json.dump(list(done.values()), f)
        time.sleep(1.2 + random.random() * 0.8)

    with open(out_file, "w") as f:
        json.dump(list(done.values()), f)
    ok = sum(1 for r in done.values() if "error" not in r)
    print(f"done: {ok}/{len(symbols)} ok")

if __name__ == "__main__":
    main()
