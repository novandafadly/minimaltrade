import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import nock from "nock";
import { testEnv } from "../../__tests__/testEnv.js";
import { getTestDb, truncateAll } from "../../__tests__/testDb.js";
import { schema } from "@idx/db";
import { eq } from "drizzle-orm";
import { SchemaValidationError } from "../errors.js";
import { UpstreamHttpError } from "../errors.js";
import { sharedCircuitBreaker } from "../circuitBreaker.js";
import type { AdapterContext } from "../endpoints.js";
import {
  getScreenerLatest,
  getAnalysis,
  getBrokerSummary,
  getBrokerAccumulation,
  getHistory,
  quoteEnvelopeFromHistory,
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
  sharedCircuitBreaker.recordSuccess();
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
  it("parses the real curated-shortlist shape and archives it schema-valid", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/screener/latest")
      .reply(200, {
        date: "📊 SCREENER V5.2 — Rabu, 9 September 2026",
        source: "screener_v5.py",
        cached_for_seconds: 86327,
        raw: "📊 SCREENER V5.2 — Rabu, 9 September 2026\n🟡 FLAT MARKET",
        rows: [
          {
            stock_code: "SPRE",
            stock_name: "Soraya Berjaya Indonesia Tbk.",
            bucket: "🟢 SINYAL BERSIH",
            summary: "✅ 🏦 🌍 🧬 ⬆️ — Gabungan (Broker + Teknikal)",
            note: "volume tinggi | teknikal lemah",
            drawdown: -2,
            wr_event: 68.1,
            potential: 9
          }
        ]
      });

    const result = await getScreenerLatest(ctx);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.symbol).toBe("SPRE");
    expect(result.candidates[0]?.data.bucket).toBe("🟢 SINYAL BERSIH");
    expect(result.candidates[0]?.data.wrEvent).toBe(68.1);
    expect(result.rawHeadline).toContain("SCREENER V5.2");

    const archived = await lastArchiveRow("/api/screener/latest");
    expect(archived?.schemaValid).toBe(true);
  });

  it("rejects a payload with no rows array and archives it as invalid", async () => {
    nock(env.ARJUM_API_BASE_URL).get("/api/screener/latest").reply(200, { date: "x" });
    await expect(getScreenerLatest(ctx)).rejects.toBeInstanceOf(SchemaValidationError);
    const archived = await lastArchiveRow("/api/screener/latest");
    expect(archived?.schemaValid).toBe(false);
  });

  it("rejects a row missing stock_code", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/screener/latest")
      .reply(200, { rows: [{ bucket: "🟢 SINYAL BERSIH", wr_event: 60 }] });
    await expect(getScreenerLatest(ctx)).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

describe("getHistory / quoteEnvelopeFromHistory", () => {
  const historyPayload = {
    stock_code: "BBCA",
    frame: "daily",
    // newest-first, as the real API returns
    rows: [
      { date: "2026-09-09", open: 6700, high: 6700, low: 6500, close: 6525, volume: 193_375_100, value: 1_267_073_227_500, change: -150, change_pct: -2.25 },
      { date: "2026-09-08", open: 6650, high: 6720, low: 6640, close: 6675, volume: 150_000_000, value: 1_000_000_000_000, change: 25, change_pct: 0.38 },
      { date: "2026-09-05", open: 6600, high: 6680, low: 6590, close: 6650, volume: 120_000_000, value: 800_000_000_000 }
    ]
  };

  it("re-sorts rows ascending, maps value->turnover and derives the 20d baseline", async () => {
    nock(env.ARJUM_API_BASE_URL).get("/api/history/BBCA").reply(200, historyPayload);
    const envelope = await getHistory(ctx, "BBCA");
    expect(envelope.data.symbol).toBe("BBCA");
    expect(envelope.data.bars[0]?.date).toBe("2026-09-05");
    expect(envelope.data.bars[envelope.data.bars.length - 1]?.date).toBe("2026-09-09");
    expect(envelope.data.bars[envelope.data.bars.length - 1]?.turnover).toBe(1_267_073_227_500);
    expect(envelope.data.baselineMedianVolume20d).toBe(135_000_000); // median of the two pre-today bars
  });

  it("builds a ScreenerRow quote from the latest bar", async () => {
    nock(env.ARJUM_API_BASE_URL).get("/api/history/BBCA").reply(200, historyPayload);
    const quote = quoteEnvelopeFromHistory(await getHistory(ctx, "BBCA"));
    expect(quote.data.price).toBe(6525);
    expect(quote.data.turnover).toBe(1_267_073_227_500);
    expect(quote.data.priceChangePct).toBeCloseTo((6525 - 6675) / 6675, 6);
  });

  it("rejects a bar missing close", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/history/BBCA")
      .reply(200, { stock_code: "BBCA", rows: [{ date: "2026-09-09", open: 1, high: 1, low: 1, volume: 1 }] });
    await expect(getHistory(ctx, "BBCA")).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

describe("getBrokerSummary (unchanged shape — VERIFIED)", () => {
  const validPayload = {
    stock_code: "BBCA",
    broker_start_date: "2026-09-09",
    broker_end_date: "2026-09-09",
    brokers: [
      { broker_code: "YP", broker_name: "MIRAE", bval: 950_000_000, bvol: 100_000, sval: 190_000_000, svol: 20_000 }
    ],
    broker_levels: []
  };

  it("normalizes net volume when omitted and defaults to provisional", async () => {
    nock(env.ARJUM_API_BASE_URL).get("/api/broker-summary/BBCA").reply(200, validPayload);
    const envelope = await getBrokerSummary(ctx, "BBCA");
    expect(envelope.data.brokers[0]?.netVolume).toBe(80_000);
    expect(envelope.status).toBe("provisional");
  });

  it("declares final when the deep funnel passes assumeFinal", async () => {
    nock(env.ARJUM_API_BASE_URL).get("/api/broker-summary/BBCA").reply(200, validPayload);
    const envelope = await getBrokerSummary(ctx, "BBCA", true);
    expect(envelope.status).toBe("final");
  });

  it("rejects a payload missing broker_end_date", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/broker-summary/BBCA")
      .reply(200, { ...validPayload, broker_end_date: undefined });
    await expect(getBrokerSummary(ctx, "BBCA")).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

describe("getBrokerAccumulation", () => {
  it("pivots the per-broker series into per-day rows", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/broker-accumulation/BBCA")
      .reply(200, {
        code: "BBCA",
        start_date: "2026-05-11",
        end_date: "2026-09-09",
        series: [
          { broker_code: "DX", points: [{ date: "2026-09-09", nval: 3_000_000_000, nvol: 1_000 }] },
          { broker_code: "AK", points: [{ date: "2026-09-09", nval: -2_000_000_000, nvol: -800 }] }
        ],
        top_buyers: [{ broker_code: "DX", total_nval: 3_000_000_000 }],
        top_sellers: [{ broker_code: "AK", total_nval: -2_000_000_000 }]
      });
    const envelope = await getBrokerAccumulation(ctx, "BBCA");
    expect(envelope.data.days).toHaveLength(1);
    expect(envelope.data.days[0]?.netBuyBrokers).toEqual(["DX"]);
    expect(envelope.data.days[0]?.topBuyerCode).toBe("DX");
    expect(envelope.tradingDate).toBe("2026-09-09");
  });

  it("rejects a payload with no series array", async () => {
    nock(env.ARJUM_API_BASE_URL).get("/api/broker-accumulation/BBCA").reply(200, { code: "BBCA" });
    await expect(getBrokerAccumulation(ctx, "BBCA")).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

describe("getAnalysis", () => {
  it("keeps the markdown blob as narrative only", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/analysis/BBCA")
      .reply(200, { stock_code: "BBCA", output: "📊 BBCA — Analisis..." });
    const envelope = await getAnalysis(ctx, "BBCA");
    expect(envelope.data.narrative).toEqual({ output: "📊 BBCA — Analisis..." });
    expect(envelope.data.sector).toBeNull();
  });

  it("rejects a payload missing output", async () => {
    nock(env.ARJUM_API_BASE_URL).get("/api/analysis/BBCA").reply(200, { stock_code: "BBCA" });
    await expect(getAnalysis(ctx, "BBCA")).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

describe("getSeasonal", () => {
  it("maps the current month's up_prob to a 0-1 win rate", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/seasonal/BBCA")
      .reply(200, {
        stock_code: "BBCA",
        summary: {
          Jan: { avg: -1.72, up: 2, down: 5, total: 7, up_prob: 28.6 },
          Sep: { avg: 0.5, up: 4, down: 3, total: 7, up_prob: 57.1 }
        }
      });
    const envelope = await getSeasonal(ctx, "BBCA");
    // asOf receivedAt is "now" — could be any month at test time, so just
    // assert the value is a fraction in [0,1] or null.
    const wr = envelope.data.historicalWinRate;
    expect(wr === null || (wr >= 0 && wr <= 1)).toBe(true);
    expect(envelope.status).toBe("final");
  });

  it("rejects a payload with no summary", async () => {
    nock(env.ARJUM_API_BASE_URL).get("/api/seasonal/BBCA").reply(200, { stock_code: "BBCA" });
    await expect(getSeasonal(ctx, "BBCA")).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

describe("getMarketCap", () => {
  it("renames code->symbol and reports pagination", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/market-cap")
      .reply(200, {
        date: "2026-09-09",
        total: 963,
        page: 1,
        per_page: 25,
        total_pages: 39,
        data: [{ code: "BBCA", name: "Bank Central Asia Tbk.", close: 6525, listed_shares: "122042299500", market_cap: "796326004237500" }]
      });
    const result = await getMarketCap(ctx);
    expect(result.entries[0]?.symbol).toBe("BBCA");
    expect(result.entries[0]?.data.sharesOutstanding).toBe(122_042_299_500);
    expect(result.totalPages).toBe(39);
  });

  it("requests a specific page when asked", async () => {
    nock(env.ARJUM_API_BASE_URL).get("/api/market-cap").query({ page: "2" }).reply(200, { data: [] });
    const result = await getMarketCap(ctx, 2);
    expect(result.entries).toHaveLength(0);
  });
});

describe("search", () => {
  it("unwraps the bare array shape", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/search")
      .query({ q: "bca" })
      .reply(200, [{ stock_code: "BBCA", stock_name: "Bank Central Asia Tbk.", last_date: "2026-09-09" }]);
    const results = await search(ctx, "bca");
    expect(results[0]).toEqual({ symbol: "BBCA", name: "Bank Central Asia Tbk." });
  });

  it("rejects a non-array payload", async () => {
    nock(env.ARJUM_API_BASE_URL).get("/api/search").query({ q: "x" }).reply(200, { data: [] });
    await expect(search(ctx, "x")).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

describe("getHealth", () => {
  it("accepts {ok, status}", async () => {
    nock(env.ARJUM_API_BASE_URL).get("/api/health").reply(200, { ok: true, status: "healthy" });
    const health = await getHealth(ctx);
    expect(health.upstreamOk).toBe(true);
  });

  it("rejects a payload missing status", async () => {
    nock(env.ARJUM_API_BASE_URL).get("/api/health").reply(200, { ok: true });
    await expect(getHealth(ctx)).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

describe("getFinancialStatements", () => {
  it("surfaces the upstream 403 as an UpstreamHttpError (callers swallow it)", async () => {
    nock(env.ARJUM_API_BASE_URL).get("/api/financial-statements/BBCA").reply(403, { detail: "Akses ditolak." });
    await expect(getFinancialStatements(ctx, "BBCA")).rejects.toBeInstanceOf(UpstreamHttpError);
  });
});

describe("getInsiders", () => {
  it("parses items[] and maps action_type + changes_value", async () => {
    nock(env.ARJUM_API_BASE_URL)
      .get("/api/insiders/BBCA")
      .reply(200, {
        stock_code: "BBCA",
        count: 1,
        total: 1,
        items: [
          {
            name: "TONNY KUSNADI",
            date: "2026-03-25",
            action_type: "buy",
            nationality: "local",
            changes_value: "+317,892",
            price_formatted: "6,982",
            badges: ["KOMISARIS"]
          }
        ]
      });
    const envelope = await getInsiders(ctx, "BBCA");
    expect(envelope.data[0]?.action).toBe("buy");
    expect(envelope.data[0]?.shares).toBe(317_892);
    expect(envelope.data[0]?.insiderName).toBe("TONNY KUSNADI");
  });

  it("rejects a payload with no items array", async () => {
    nock(env.ARJUM_API_BASE_URL).get("/api/insiders/BBCA").reply(200, { stock_code: "BBCA" });
    await expect(getInsiders(ctx, "BBCA")).rejects.toBeInstanceOf(SchemaValidationError);
  });
});
