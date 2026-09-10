import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { Db } from "@idx/db";
import { schema } from "@idx/db";
import type { StrategyConfig } from "@idx/config";
import type { DataEnvelope, HistoryData, MarketCapEntry, ScreenerSignalRow, Signal, TradePlan } from "@idx/domain";
import { planFromHistory, mulberry32 } from "@idx/backtest";
import { getOrFetch } from "../cache/cache.js";
import { CACHE_TTL_SECONDS } from "../cache/ttl.js";
import { getHistory, type AdapterContext } from "../adapter/endpoints.js";
import {
  arjumShortlist,
  consensusShortlist,
  hasEnoughHistory,
  marketcapShortlist,
  technicalShortlist,
  technicalUniverse
} from "./screeners.js";

/**
 * Shadow-mode persistence (blueprint non-goal: forward-test before real
 * capital). Every EOD, alongside the live deep-funnel signal, this writes a
 * plan for each of several `source`s over the same forward window:
 *
 *  - `live`              — mirror of each real deep-funnel trade plan
 *                          (ARJUM shortlist + full feature/scoring/risk engine)
 *  - `baseline_volume`   — top-N of the ARJUM pool by latest-bar volume
 *  - `baseline_random`   — N seeded-random picks of the ARJUM pool
 *  - `screener_arjum`    — top-N ARJUM shortlist by ARJUM's own edge
 *  - `screener_marketcap`— ARJUM ∩ liquidity/size band (option B)
 *  - `screener_technical`— liquid momentum-breakout screen (option D)
 *  - `screener_consensus`— names ≥2 screeners agree on (ensemble)
 *
 * Every source's plan (except `live`) is built the SAME way — `planFromHistory`
 * off OHLCV with a 5-day-low stop — so the comparison isolates *screener*
 * quality from *engine* quality. A forward evaluator (./evaluate.ts) fills in
 * outcomes once ~3 trading days of `daily_bar` history exist.
 */

type ShadowSource =
  | "live"
  | "baseline_volume"
  | "baseline_random"
  | "screener_arjum"
  | "screener_marketcap"
  | "screener_technical"
  | "screener_consensus";

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
  /** whole-universe market cap (for the marketcap + technical screeners) */
  marketCap?: MarketCapEntry[];
}

export interface PersistShadowResult {
  live: number;
  baseline: number;
  screeners: number;
}

export async function persistShadowPlans(opts: PersistShadowOpts): Promise<PersistShadowResult> {
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

  // 2. gather OHLCV for every symbol any screener might rank: the ARJUM pool
  //    plus the bounded technical universe (cache hit for anything the deep
  //    funnel already fetched; a bounded number of misses otherwise).
  const arjumRows = [...new Map(opts.screenerCandidates.map((e) => [e.symbol, e.data])).values()];
  const mcap = opts.marketCap ?? [];
  const mcapBySymbol = new Map(mcap.map((e) => [e.symbol, e]));
  const techUniverse = technicalUniverse(mcap);
  const symbols = [...new Set([...arjumRows.map((r) => r.symbol), ...techUniverse])];

  const histories = new Map<string, HistoryData>();
  for (const sym of symbols) {
    try {
      const { value } = await getOrFetch(redis, "history", sym, CACHE_TTL_SECONDS.history, () => getHistory(ctx, sym));
      histories.set(sym, value.data);
    } catch {
      // skip a symbol whose history can't be fetched
    }
  }

  const arjumPool = arjumRows.map((r) => r.symbol).filter((s) => hasEnoughHistory(histories.get(s)));

  const lastVol = (s: string) => {
    const b = histories.get(s)?.bars ?? [];
    return b[b.length - 1]?.volume ?? 0;
  };

  const rand = mulberry32(hashDate(tradingDate));
  const picksBySource: Record<Exclude<ShadowSource, "live">, string[]> = {
    baseline_volume: [...arjumPool].sort((a, b) => lastVol(b) - lastVol(a)).slice(0, N),
    baseline_random: [...arjumPool].sort(() => rand() - 0.5).slice(0, N),
    screener_arjum: arjumShortlist(arjumRows, histories),
    screener_marketcap: marketcapShortlist(arjumRows, mcapBySymbol, histories),
    screener_technical: technicalShortlist(histories, techUniverse),
    screener_consensus: []
  };
  picksBySource.screener_consensus = consensusShortlist([
    picksBySource.screener_arjum,
    picksBySource.screener_marketcap,
    picksBySource.screener_technical
  ]);

  let baseline = 0;
  let screeners = 0;
  for (const [source, picks] of Object.entries(picksBySource) as [Exclude<ShadowSource, "live">, string[]][]) {
    for (const sym of picks) {
      const history = histories.get(sym);
      if (!history) continue;
      const plan = planFromHistory(sym, tradingDate, history, cfg, sessionEndIso, "low5");
      if (!plan) continue;
      await upsert(ctx.db, shadowRow(source, tradingDate, sym, plan, {}));
      if (source.startsWith("baseline_")) baseline += 1;
      else screeners += 1;
    }
  }

  return { live, baseline, screeners };
}
