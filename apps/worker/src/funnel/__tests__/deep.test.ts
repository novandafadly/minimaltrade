import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import nock from "nock";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { DEFAULT_STRATEGY_CONFIG } from "@idx/config";
import { schema, type Db } from "@idx/db";
import type { DataEnvelope, ScreenerSignalRow } from "@idx/domain";
import { testEnv } from "../../__tests__/testEnv.js";
import { getTestDb, truncateAll } from "../../__tests__/testDb.js";
import { sharedCircuitBreaker } from "../../adapter/circuitBreaker.js";
import { runDeepFunnel } from "../deep.js";
import type { MidFunnelScored } from "../mid.js";

const env = testEnv();
let db: Db;

let portCounter = 22000;
function freshRedis(): Redis {
  portCounter += 1;
  return new RedisMock(portCounter) as unknown as Redis;
}

function signalEnvelope(symbol: string): DataEnvelope<ScreenerSignalRow> {
  return {
    symbol,
    tradingDate: "2026-09-09",
    eventTime: "2026-09-09T15:49:00+07:00",
    publishedAt: "2026-09-09T15:49:00+07:00",
    receivedAt: "2026-09-09T15:49:05+07:00",
    source: "arjum",
    segment: "unknown",
    revisionId: null,
    status: "final",
    data: {
      symbol,
      name: `${symbol} Tbk.`,
      bucket: "🟢 SINYAL BERSIH",
      summary: "✅ 🏦 🌍 🧬 — Gabungan (Broker + Teknikal)",
      note: null,
      drawdown: -3,
      wrEvent: 62,
      potential: 9
    }
  };
}

function midCandidate(symbol: string): MidFunnelScored {
  return { symbol, signal: signalEnvelope(symbol), edgeScore: 0.7 };
}

/** 25 ascending daily bars ending 2026-09-09, all liquid enough to clear the
 * deep-funnel price/turnover floor. Real `/api/history` returns rows
 * newest-first; the adapter re-sorts. */
function historyRows(symbol: string) {
  const rows = [];
  for (let i = 24; i >= 0; i--) {
    const d = new Date(Date.UTC(2026, 8, 9) - i * 86400000).toISOString().slice(0, 10);
    rows.push({
      date: d,
      open: 1000,
      high: 1015,
      low: 990,
      close: 1005,
      volume: 500_000_000,
      value: 502_500_000_000,
      change: 5,
      change_pct: 0.5
    });
  }
  return { stock_code: symbol, frame: "daily", rows: rows.reverse() };
}

function mockDeepFunnelCallsFor(symbol: string) {
  nock(env.ARJUM_API_BASE_URL)
    .get(`/api/history/${symbol}`)
    .reply(200, historyRows(symbol));
  nock(env.ARJUM_API_BASE_URL)
    .get(`/api/broker-summary/${symbol}`)
    .reply(200, {
      stock_code: symbol,
      broker_start_date: "2026-09-09",
      broker_end_date: "2026-09-09",
      brokers: [
        { broker_code: "YP", bval: 100_000_000, bvol: 100_000, sval: 10_000_000, svol: 10_000, nval: 90_000_000, nvol: 90_000 },
        { broker_code: "CC", bval: 50_000_000, bvol: 50_000, sval: 5_000_000, svol: 5_000, nval: 45_000_000, nvol: 45_000 },
        { broker_code: "AK", bval: 5_000_000, bvol: 5_000, sval: 40_000_000, svol: 40_000, nval: -35_000_000, nvol: -35_000 }
      ],
      broker_levels: []
    });
  nock(env.ARJUM_API_BASE_URL)
    .get(`/api/broker-accumulation/${symbol}`)
    .reply(200, {
      code: symbol,
      start_date: "2026-05-11",
      end_date: "2026-09-09",
      series: [
        { broker_code: "YP", points: [{ date: "2026-09-09", nval: 90_000_000, nvol: 90_000, cum_nval: 90_000_000 }] },
        { broker_code: "AK", points: [{ date: "2026-09-09", nval: -35_000_000, nvol: -35_000, cum_nval: -35_000_000 }] }
      ],
      top_buyers: [{ broker_code: "YP", total_nval: 90_000_000 }],
      top_sellers: [{ broker_code: "AK", total_nval: -35_000_000 }]
    });
  nock(env.ARJUM_API_BASE_URL)
    .get(`/api/seasonal/${symbol}`)
    .reply(200, { stock_code: symbol, summary: { Sep: { avg: 1.2, up: 4, down: 3, total: 7, up_prob: 57.1 } } });
  nock(env.ARJUM_API_BASE_URL)
    .get(`/api/insiders/${symbol}`)
    .reply(200, { stock_code: symbol, count: 0, total: 0, items: [] });
  nock(env.ARJUM_API_BASE_URL)
    .get(`/api/analysis/${symbol}`)
    .reply(200, { stock_code: symbol, output: "📊 analysis text" });
  nock(env.ARJUM_API_BASE_URL).get(`/api/financial-statements/${symbol}`).reply(403, { detail: "Akses ditolak." });
}

beforeAll(() => {
  nock.disableNetConnect();
  db = getTestDb();
});

beforeEach(async () => {
  await truncateAll();
  sharedCircuitBreaker.recordSuccess();
  nock.cleanAll();
});

afterEach(() => {
  expect(nock.isDone()).toBe(true);
  nock.cleanAll();
});

describe("runDeepFunnel", () => {
  it("only enriches symbols present in the mid-funnel survivor set", async () => {
    const redis = freshRedis();
    const survivors = [midCandidate("BBCA"), midCandidate("BBRI")];
    mockDeepFunnelCallsFor("BBCA");
    mockDeepFunnelCallsFor("BBRI");

    const result = await runDeepFunnel(survivors, {
      env,
      db,
      redis,
      strategyConfig: DEFAULT_STRATEGY_CONFIG,
      skipS3Archive: true,
      now: "2026-09-09T16:00:00+07:00"
    });

    expect(result.activeWatchlist.map((c) => c.symbol).sort()).toEqual(["BBCA", "BBRI"]);
    expect(result.skipped).toHaveLength(0);

    const featureRows = await db.select({ symbol: schema.featureSnapshot.symbol }).from(schema.featureSnapshot);
    const persisted = new Set(featureRows.map((r) => r.symbol));
    expect(persisted).toEqual(new Set(["BBCA", "BBRI"]));

    const barRows = await db.select({ symbol: schema.dailyBar.symbol }).from(schema.dailyBar);
    expect(barRows.length).toBeGreaterThan(0);
  });

  it("limits full trade-plan generation to at most deepFunnelTradePlanMax of the watchlist", async () => {
    const redis = freshRedis();
    const symbols = ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE"];
    symbols.forEach(mockDeepFunnelCallsFor);

    const config = {
      ...DEFAULT_STRATEGY_CONFIG,
      funnel: { ...DEFAULT_STRATEGY_CONFIG.funnel, deepFunnelWatchlistMax: 5, deepFunnelTradePlanMax: 2 }
    };

    const result = await runDeepFunnel(
      symbols.map((s) => midCandidate(s)),
      { env, db, redis, strategyConfig: config, skipS3Archive: true, now: "2026-09-09T16:00:00+07:00" }
    );

    expect(result.activeWatchlist.length).toBeLessThanOrEqual(5);
    expect(result.tradePlanCandidates.length).toBeLessThanOrEqual(2);
  });

  it("skips a candidate whose price is below the deep-funnel floor", async () => {
    const redis = freshRedis();
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/history/GOCAP")
      .reply(200, {
        stock_code: "GOCAP",
        frame: "daily",
        rows: [
          { date: "2026-09-08", open: 50, high: 50, low: 50, close: 50, volume: 1, value: 50 },
          { date: "2026-09-09", open: 50, high: 50, low: 50, close: 50, volume: 1, value: 50 }
        ]
      });

    const result = await runDeepFunnel([midCandidate("GOCAP")], {
      env,
      db,
      redis,
      strategyConfig: DEFAULT_STRATEGY_CONFIG,
      skipS3Archive: true,
      now: "2026-09-09T16:00:00+07:00"
    });

    expect(result.activeWatchlist).toHaveLength(0);
    expect(result.skipped[0]?.symbol).toBe("GOCAP");
  });
});
