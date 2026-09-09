import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import nock from "nock";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { DEFAULT_STRATEGY_CONFIG } from "@idx/config";
import { schema, type Db } from "@idx/db";
import type { DataEnvelope, ScreenerRow } from "@idx/domain";
import { testEnv } from "../../__tests__/testEnv.js";
import { getTestDb, truncateAll } from "../../__tests__/testDb.js";
import { sharedCircuitBreaker } from "../../adapter/circuitBreaker.js";
import { runDeepFunnel } from "../deep.js";
import type { MidFunnelScored } from "../mid.js";

const env = testEnv();
let db: Db;

// ioredis-mock v6+ shares in-memory state across instances on the same
// host:port; give every test its own port so tests stay isolated.
let portCounter = 22000;
function freshRedis(): Redis {
  portCounter += 1;
  return new RedisMock(portCounter) as unknown as Redis;
}

function screenerEnvelope(symbol: string): DataEnvelope<ScreenerRow> {
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
      board: null,
      price: 1000,
      priceChange: 10,
      priceChangePct: 1,
      volume: 500000,
      turnover: 500000000,
      bestBid: 995,
      bestOffer: 1000,
      spread: 5,
      isSuspended: false,
      notation: null
    }
  };
}

function midCandidate(symbol: string): MidFunnelScored {
  return {
    symbol,
    screener: screenerEnvelope(symbol),
    liquidityScore: 0.8,
    gainScore: 0.5,
    chasePenalty: 0,
    distributionPenalty: 0,
    compositeProxyScore: 0.7
  };
}

/** Registers nock interceptors for the full deep-funnel enrichment set of
 * calls for a single symbol, with minimal schema-valid fixtures. */
function mockDeepFunnelCallsFor(symbol: string) {
  nock(env.ARJUM_API_BASE_URL)
    .get(`/api/broker-summary/${symbol}`)
    .reply(200, {
      symbol,
      trading_date: "2026-09-09",
      segment: "regular",
      status: "final",
      brokers: [
        { broker_code: "YP", buy_volume: 100000, buy_value: 100000000, sell_volume: 10000, sell_value: 10000000 },
        { broker_code: "CC", buy_volume: 50000, buy_value: 50000000, sell_volume: 5000, sell_value: 5000000 }
      ]
    });
  nock(env.ARJUM_API_BASE_URL)
    .get(`/api/broker-accumulation/${symbol}`)
    .reply(200, { symbol, window_days: 5, days: [{ date: "2026-09-09", net_buy_brokers: ["YP", "CC"] }] });
  nock(env.ARJUM_API_BASE_URL)
    .get(`/api/history/${symbol}`)
    .reply(200, {
      symbol,
      bars: [{ date: "2026-09-09", open: 990, high: 1010, low: 985, close: 1000, volume: 500000 }],
      baseline_median_volume_20d: 400000
    });
  nock(env.ARJUM_API_BASE_URL)
    .get(`/api/seasonal/${symbol}`)
    .reply(200, { symbol, month: 9, historical_win_rate: 0.5, sample_size: 10 });
  nock(env.ARJUM_API_BASE_URL)
    .get(`/api/insiders/${symbol}`)
    .reply(200, { symbol, data: [] });
  nock(env.ARJUM_API_BASE_URL)
    .get(`/api/analysis/${symbol}`)
    .reply(200, { symbol, sector: "Banking", market_cap: 1000000000, as_of: "2026-09-09" });
  nock(env.ARJUM_API_BASE_URL)
    .get(`/api/financial-statements/${symbol}`)
    .reply(200, { symbol, fiscal_period: "2026-Q2", revenue: 1, net_income: 1, red_flags: [] });
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
  it("only enriches symbols present in the mid-funnel survivor set, never anything outside it", async () => {
    const redis = freshRedis();
    const survivors = [midCandidate("BBCA"), midCandidate("BBRI")];
    mockDeepFunnelCallsFor("BBCA");
    mockDeepFunnelCallsFor("BBRI");

    // Deliberately do NOT register interceptors for "TLKM" (outside the mid
    // funnel survivor set). If runDeepFunnel ever called upstream for a
    // symbol outside its input list, nock (with disableNetConnect) would
    // throw a connection-refused error and this test would fail.

    const result = await runDeepFunnel(survivors, {
      env,
      db,
      redis,
      strategyConfig: DEFAULT_STRATEGY_CONFIG,
      skipS3Archive: true,
      now: "2026-09-09T16:00:00+07:00"
    });

    const enrichedSymbols = result.activeWatchlist.map((c) => c.symbol).sort();
    expect(enrichedSymbols).toEqual(["BBCA", "BBRI"]);
    expect(result.skipped).toHaveLength(0);

    // Only survivor symbols were persisted -- confirms no stray enrichment.
    const featureRows = await db.select({ symbol: schema.featureSnapshot.symbol }).from(schema.featureSnapshot);
    const persistedSymbols = new Set(featureRows.map((r) => r.symbol));
    expect(persistedSymbols).toEqual(new Set(["BBCA", "BBRI"]));
    expect(persistedSymbols.has("TLKM")).toBe(false);
  });

  it("limits full trade-plan generation to at most deepFunnelTradePlanMax of the watchlist", async () => {
    const redis = freshRedis();
    const symbols = ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE"];
    const survivors = symbols.map((s) => midCandidate(s));
    symbols.forEach(mockDeepFunnelCallsFor);

    const config = {
      ...DEFAULT_STRATEGY_CONFIG,
      funnel: { ...DEFAULT_STRATEGY_CONFIG.funnel, deepFunnelWatchlistMax: 5, deepFunnelTradePlanMax: 2 }
    };

    const result = await runDeepFunnel(survivors, {
      env,
      db,
      redis,
      strategyConfig: config,
      skipS3Archive: true,
      now: "2026-09-09T16:00:00+07:00"
    });

    expect(result.activeWatchlist.length).toBeLessThanOrEqual(5);
    expect(result.tradePlanCandidates.length).toBeLessThanOrEqual(2);
  });
});
