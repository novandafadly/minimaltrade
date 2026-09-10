import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { Db } from "@idx/db";
import { schema } from "@idx/db";
import type { StrategyConfig } from "@idx/config";
import type { DataEnvelope, HistoryData, ScreenerSignalRow, Signal, TradePlan } from "@idx/domain";
import { planFromHistory, mulberry32 } from "@idx/backtest";
import { getOrFetch } from "../cache/cache.js";
import { CACHE_TTL_SECONDS } from "../cache/ttl.js";
import { getHistory, type AdapterContext } from "../adapter/endpoints.js";

/**
 * Shadow-mode persistence (blueprint non-goal: forward-test before real
 * capital). Every EOD, alongside the live deep-funnel signal, this writes:
 *
 *  - `live`            — a mirror of each real trade plan the deep funnel
 *                        produced (category STRONG_BUY / SPECULATIVE_BUY etc.)
 *  - `baseline_volume` — top-N of the screener candidate pool by latest-bar
 *                        volume, plan built from OHLCV only (5-day-low stop)
 *  - `baseline_random` — N seeded-random picks of the same pool
 *
 * A forward evaluator (./evaluate.ts) fills in the outcome once ~3 trading
 * days of `daily_bar` history exist. Comparing the three sources' realised
 * expectancy / profit factor over a few weeks is how "does the broker-flow
 * score beat picking by volume / at random?" gets answered.
 */

type ShadowSource = "live" | "baseline_volume" | "baseline_random";

function hashDate(date: string): number {
  let h = 0;
  for (let i = 0; i < date.length; i++) h = (h * 31 + date.charCodeAt(i)) | 0;
  return h >>> 0;
}

function shadowRow(
  source: ShadowSource,
  tradingDate: string,
  symbol: string,
  plan: TradePlan,
  extra: { category?: string | null; compositeScore?: number | null }
) {
  return {
    id: randomUUID(),
    tradingDate,
    symbol,
    source,
    category: extra.category ?? null,
    compositeScore: extra.compositeScore != null ? String(extra.compositeScore) : null,
    configVersion: plan.configVersion,
    generatedAt: new Date(plan.generatedAt),
    expiry: new Date(plan.expiry),
    entryTrigger: String(plan.entryTrigger),
    maxBuyPrice: String(plan.maxBuyPrice),
    slPrice: String(plan.slPrice),
    tp1Price: String(plan.tp1Price),
    tp1Lots: plan.tp1Lots,
    tp2Price: String(plan.tp2Price),
    tp2Lots: plan.tp2Lots,
    totalLots: plan.totalLots,
    netRewardToRisk: String(plan.netRewardToRisk),
    isNoTrade: plan.isNoTrade,
    planJson: plan as unknown as object
  };
}

async function upsert(db: Db, row: ReturnType<typeof shadowRow>): Promise<void> {
  await db
    .insert(schema.shadowPlan)
    .values(row)
    .onConflictDoNothing({
      target: [schema.shadowPlan.tradingDate, schema.shadowPlan.source, schema.shadowPlan.symbol]
    });
}

export interface PersistShadowOpts {
  ctx: AdapterContext;
  redis: Redis;
  strategyConfig: StrategyConfig;
  tradingDate: string;
  sessionEndIso: string;
  /** the raw screener candidate pool (before top/mid edge-ranking) */
  screenerCandidates: DataEnvelope<ScreenerSignalRow>[];
  /** the live deep-funnel signals that carry a real trade plan */
  liveSignals: Signal[];
}

export async function persistShadowPlans(opts: PersistShadowOpts): Promise<{ live: number; baseline: number }> {
  const { ctx, redis, strategyConfig: cfg, tradingDate, sessionEndIso } = opts;
  const N = cfg.funnel.deepFunnelTradePlanMax;

  // 1. live mirror
  let live = 0;
  for (const sig of opts.liveSignals) {
    if (!sig.plan) continue;
    await upsert(
      ctx.db,
      shadowRow("live", tradingDate, sig.symbol, sig.plan, {
        category: sig.category,
        compositeScore: sig.compositeScore
      })
    );
    live += 1;
  }

  // 2. baseline candidate histories (cache hit for anything the deep funnel
  //    already fetched; a few cache misses for the rest).
  const symbols = [...new Set(opts.screenerCandidates.map((e) => e.symbol))];
  const histories = new Map<string, HistoryData>();
  for (const sym of symbols) {
    try {
      const { value } = await getOrFetch(redis, "history", sym, CACHE_TTL_SECONDS.history, () => getHistory(ctx, sym));
      histories.set(sym, value.data);
    } catch {
      // skip a symbol whose history can't be fetched
    }
  }
  const withHistory = symbols.filter((s) => (histories.get(s)?.bars.length ?? 0) >= 15);

  const lastVol = (s: string) => {
    const b = histories.get(s)?.bars ?? [];
    return b[b.length - 1]?.volume ?? 0;
  };

  const volPicks = [...withHistory].sort((a, b) => lastVol(b) - lastVol(a)).slice(0, N);
  const rand = mulberry32(hashDate(tradingDate));
  const randPicks = [...withHistory].sort(() => rand() - 0.5).slice(0, N);

  let baseline = 0;
  for (const [source, picks] of [
    ["baseline_volume", volPicks],
    ["baseline_random", randPicks]
  ] as const) {
    for (const sym of picks) {
      const plan = planFromHistory(sym, tradingDate, histories.get(sym)!, cfg, sessionEndIso, "low5");
      if (!plan) continue;
      await upsert(ctx.db, shadowRow(source, tradingDate, sym, plan, {}));
      baseline += 1;
    }
  }

  return { live, baseline };
}
