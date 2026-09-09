import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import nock from "nock";
import { testEnv } from "../../__tests__/testEnv.js";
import { getTestDb, truncateAll } from "../../__tests__/testDb.js";
import { schema } from "@idx/db";
import { eq } from "drizzle-orm";
import { SchemaValidationError } from "../errors.js";
import { sharedCircuitBreaker } from "../circuitBreaker.js";
import type { AdapterContext } from "../endpoints.js";
import {
  getScreenerLatest,
  getAnalysis,
  getBrokerSummary,
  getBrokerAccumulation,
  getHistory,
  getSeasonal,
  getMarketCap,
  search,
  getHealth,
  getFinancialStatements,
  getInsiders
} from "../endpoints.js";

const env = testEnv();
const db = getTestDb();
const ctx: AdapterContext = { env, db, skipS3Archive: true };

beforeAll(async () => {
  nock.disableNetConnect();
});

beforeEach(async () => {
  await truncateAll();
  sharedCircuitBreaker.recordSuccess(); // reset breaker state between tests
  nock.cleanAll();
});

afterEach(() => {
  expect(nock.isDone()).toBe(true);
});

async function lastArchiveRow(endpoint: string) {
  const rows = await db
    .select()
    .from(schema.rawPayloadArchive)
    .where(eq(schema.rawPayloadArchive.endpoint, endpoint))
    .orderBy(schema.rawPayloadArchive.receivedAt);
  return rows[rows.length - 1];
}

describe("getScreenerLatest", () => {
  it("accepts a valid payload and archives it as schema-valid", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/screener/latest")
      .reply(200, {
        as_of: "2026-09-09T15:49:00+07:00",
        trading_date: "2026-09-09",
        status: "final",
        data: [
          {
            symbol: "BBCA",
            price: 9500,
            change: 100,
            change_pct: 1.06,
            volume: 1000000,
            turnover: 9500000000,
            best_bid: 9490,
            best_offer: 9500,
            is_suspended: false,
            notation: null
          }
        ]
      });

    const result = await getScreenerLatest(ctx);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.symbol).toBe("BBCA");
    expect(result.rows[0]?.status).toBe("final");
    expect(result.rows[0]?.data.price).toBe(9500);
    expect(result.rows[0]?.data.spread).toBe(10);

    const archived = await lastArchiveRow("/api/screener/latest");
    expect(archived?.schemaValid).toBe(true);
  });

  it("rejects a payload missing the required as_of field and archives it as invalid", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/screener/latest")
      .reply(200, { data: [] });

    await expect(getScreenerLatest(ctx)).rejects.toBeInstanceOf(SchemaValidationError);
    const archived = await lastArchiveRow("/api/screener/latest");
    expect(archived?.schemaValid).toBe(false);
    expect(archived?.schemaErrors).toBeTruthy();
  });

  it("marks a row provisional when the source declares status=provisional even with as_of present", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/screener/latest")
      .reply(200, {
        as_of: "2026-09-09T10:00:00+07:00",
        status: "provisional",
        data: [
          { symbol: "TLKM", price: 3500, volume: 500000, turnover: 1750000000 }
        ]
      });

    const result = await getScreenerLatest(ctx);
    expect(result.rows[0]?.status).toBe("provisional");
  });

  it("rejects a row with a wrong-typed price field (boolean instead of number/string)", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/screener/latest")
      .reply(200, {
        as_of: "2026-09-09T10:00:00+07:00",
        data: [{ symbol: "TLKM", price: true, volume: 1, turnover: 1 }]
      });

    await expect(getScreenerLatest(ctx)).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

describe("getAnalysis", () => {
  it("accepts a valid payload", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/analysis/BBCA")
      .reply(200, { symbol: "BBCA", sector: "Banking", market_cap: "1200000000000", as_of: "2026-09-09" });

    const envelope = await getAnalysis(ctx, "BBCA");
    expect(envelope.data.marketCap).toBe(1_200_000_000_000);
    expect(envelope.status).toBe("provisional"); // no declaredStatus given -> defaults provisional
  });

  it("marks the envelope provisional when as_of is absent (no usable timestamp)", async () => {
    nock(env.ARJUM_API_BASE_URL).get("/api/analysis/BBCA").reply(200, { symbol: "BBCA" });
    const envelope = await getAnalysis(ctx, "BBCA");
    expect(envelope.status).toBe("provisional");
    expect(envelope.eventTime).toBeNull();
  });

  it("rejects a payload with a null symbol", async () => {
    nock(env.ARJUM_API_BASE_URL).get("/api/analysis/BBCA").reply(200, { symbol: null });
    await expect(getAnalysis(ctx, "BBCA")).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

describe("getBrokerSummary", () => {
  // Shape verified against a real https://stock.arjum.com/api/broker-summary/{code}
  // response (2026-09-09, BBCA) -- see packages/domain/src/schemas/README.md.
  const validPayload = {
    stock_code: "BBCA",
    broker_start_date: "2026-09-09",
    broker_end_date: "2026-09-09",
    broker_net: false,
    flow: "all",
    brokers: [
      {
        broker_code: "YP",
        broker_name: "MIRAE ASSET SEKURITAS INDONESIA",
        bval: 950000000,
        bvol: 100000,
        bfrq: 120,
        sval: 190000000,
        svol: 20000,
        sfrq: 30
      }
    ],
    broker_levels: []
  };

  it("accepts a valid payload and normalizes net volume/value when omitted", async () => {
    nock(env.ARJUM_API_BASE_URL).get("/api/broker-summary/BBCA").reply(200, validPayload);
    const envelope = await getBrokerSummary(ctx, "BBCA");
    expect(envelope.data.brokers[0]?.netVolume).toBe(80000);
    expect(envelope.data.symbol).toBe("BBCA");
    // No status field in the real payload -- adapter defaults to provisional
    // (see buildEnvelope's declaredStatus contract) rather than assuming final.
    expect(envelope.status).toBe("provisional");
  });

  it("rejects a payload missing broker_end_date", async () => {
    const bad = { ...validPayload, broker_end_date: undefined };
    nock(env.ARJUM_API_BASE_URL).get("/api/broker-summary/BBCA").reply(200, bad);
    await expect(getBrokerSummary(ctx, "BBCA")).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

describe("getBrokerAccumulation", () => {
  it("accepts a valid payload", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/broker-accumulation/BBCA")
      .reply(200, {
        symbol: "BBCA",
        window_days: 5,
        days: [{ date: "2026-09-09", net_buy_brokers: ["YP", "CC"], top_buyer_code: "YP", top_buyer_share: 0.12 }]
      });
    const envelope = await getBrokerAccumulation(ctx, "BBCA");
    expect(envelope.data.days).toHaveLength(1);
    expect(envelope.tradingDate).toBe("2026-09-09");
  });

  it("rejects a payload where net_buy_brokers is not an array", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/broker-accumulation/BBCA")
      .reply(200, { symbol: "BBCA", days: [{ date: "2026-09-09", net_buy_brokers: "YP" }] });
    await expect(getBrokerAccumulation(ctx, "BBCA")).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

describe("getHistory", () => {
  it("accepts a valid payload", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/history/BBCA")
      .reply(200, {
        symbol: "BBCA",
        bars: [{ date: "2026-09-09", open: "9400", high: "9550", low: "9380", close: 9500, volume: 1000000 }],
        baseline_median_volume_20d: 800000
      });
    const envelope = await getHistory(ctx, "BBCA");
    expect(envelope.data.bars[0]?.open).toBe(9400);
    expect(envelope.data.baselineMedianVolume20d).toBe(800000);
  });

  it("rejects a bar missing the close field", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/history/BBCA")
      .reply(200, { symbol: "BBCA", bars: [{ date: "2026-09-09", open: 1, high: 1, low: 1, volume: 1 }] });
    await expect(getHistory(ctx, "BBCA")).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

describe("getSeasonal", () => {
  it("accepts a valid payload", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/seasonal/BBCA")
      .reply(200, { symbol: "BBCA", month: 9, historical_win_rate: 0.62, sample_size: 8 });
    const envelope = await getSeasonal(ctx, "BBCA");
    expect(envelope.data.historicalWinRate).toBe(0.62);
    expect(envelope.status).toBe("final"); // seasonal is always declared final (statistical aggregate)
  });

  it("rejects a payload where month is a string instead of a number", async () => {
    nock(env.ARJUM_API_BASE_URL).get("/api/seasonal/BBCA").reply(200, { symbol: "BBCA", month: "9" });
    await expect(getSeasonal(ctx, "BBCA")).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

describe("getMarketCap", () => {
  it("accepts a valid payload", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/market-cap")
      .reply(200, {
        as_of: "2026-09-09",
        data: [{ symbol: "BBCA", shares_outstanding: "24000000000", market_cap: "228000000000000" }]
      });
    const result = await getMarketCap(ctx);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.data.sharesOutstanding).toBe(24_000_000_000);
  });

  it("rejects a payload with a null entry in data", async () => {
    nock(env.ARJUM_API_BASE_URL).get("/api/market-cap").reply(200, { data: [null] });
    await expect(getMarketCap(ctx)).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

describe("search", () => {
  it("accepts a valid payload", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/search")
      .query({ q: "bbca" })
      .reply(200, { data: [{ symbol: "BBCA", name: "Bank Central Asia" }] });
    const results = await search(ctx, "bbca");
    expect(results[0]?.symbol).toBe("BBCA");
  });

  it("rejects a payload missing the name field", async () => {
    nock(env.ARJUM_API_BASE_URL).get("/api/search").query({ q: "x" }).reply(200, { data: [{ symbol: "BBCA" }] });
    await expect(search(ctx, "x")).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

describe("getHealth", () => {
  it("accepts a valid payload", async () => {
    nock(env.ARJUM_API_BASE_URL).get("/api/health").reply(200, { status: "ok", latency_ms: "42" });
    const health = await getHealth(ctx);
    expect(health.upstreamOk).toBe(true);
    expect(health.latencyMs).toBe(42);
  });

  it("rejects a payload missing status", async () => {
    nock(env.ARJUM_API_BASE_URL).get("/api/health").reply(200, {});
    await expect(getHealth(ctx)).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

describe("getFinancialStatements", () => {
  it("accepts a valid payload", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/financial-statements/BBCA")
      .reply(200, {
        symbol: "BBCA",
        fiscal_period: "2026-Q2",
        revenue: "50000000000000",
        net_income: "20000000000000",
        debt_to_equity: 0.5,
        red_flags: []
      });
    const envelope = await getFinancialStatements(ctx, "BBCA");
    expect(envelope.data.revenue).toBe(50_000_000_000_000);
  });

  it("rejects a payload missing fiscal_period", async () => {
    nock(env.ARJUM_API_BASE_URL).get("/api/financial-statements/BBCA").reply(200, { symbol: "BBCA" });
    await expect(getFinancialStatements(ctx, "BBCA")).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

describe("getInsiders", () => {
  it("accepts a valid payload", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/insiders/BBCA")
      .reply(200, {
        symbol: "BBCA",
        data: [{ symbol: "BBCA", date: "2026-09-08", insider_name: "Jane Doe", action: "buy", shares: "10000" }]
      });
    const envelope = await getInsiders(ctx, "BBCA");
    expect(envelope.data[0]?.shares).toBe(10000);
    expect(envelope.tradingDate).toBe("2026-09-08");
  });

  it("rejects a payload with an invalid action enum value", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/insiders/BBCA")
      .reply(200, { symbol: "BBCA", data: [{ symbol: "BBCA", date: "2026-09-08", action: "hold", shares: 1 }] });
    await expect(getInsiders(ctx, "BBCA")).rejects.toBeInstanceOf(SchemaValidationError);
  });
});
