import {
  pgTable,
  text,
  timestamp,
  integer,
  numeric,
  boolean,
  jsonb,
  index,
  uniqueIndex
} from "drizzle-orm/pg-core";

/**
 * Postgres schema mapped 1:1 to blueprint section 9.2 "Data Model Minimum",
 * plus audit/reproducibility tables (raw_payload_archive, alert_log,
 * session_calendar_override) needed to satisfy Acceptance Criteria V1:
 * "Perhitungan dapat direproduksi dari raw snapshot, formula version, dan
 * strategy config version."
 */

export const instrument = pgTable("instrument", {
  symbol: text("symbol").primaryKey(),
  board: text("board"),
  sector: text("sector"),
  sharesOutstanding: numeric("shares_outstanding", { precision: 20, scale: 0 }),
  isActive: boolean("is_active").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const rawPayloadArchive = pgTable(
  "raw_payload_archive",
  {
    id: text("id").primaryKey(), // uuid
    endpoint: text("endpoint").notNull(),
    symbol: text("symbol"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    httpStatus: integer("http_status").notNull(),
    payload: jsonb("payload").notNull(),
    schemaValid: boolean("schema_valid").notNull(),
    schemaErrors: jsonb("schema_errors")
  },
  (t) => ({
    endpointIdx: index("raw_payload_endpoint_idx").on(t.endpoint, t.receivedAt),
    symbolIdx: index("raw_payload_symbol_idx").on(t.symbol, t.receivedAt)
  })
);

export const marketSnapshot = pgTable(
  "market_snapshot",
  {
    id: text("id").primaryKey(), // uuid
    symbol: text("symbol").notNull(),
    tradingDate: text("trading_date").notNull(), // YYYY-MM-DD
    eventTime: timestamp("event_time", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    source: text("source").notNull(),
    segment: text("segment").notNull(), // regular | cash | negotiated | unknown
    revisionId: text("revision_id"),
    status: text("status").notNull(), // final | provisional
    price: numeric("price", { precision: 14, scale: 2 }).notNull(),
    priceChangePct: numeric("price_change_pct", { precision: 8, scale: 4 }),
    volume: numeric("volume", { precision: 20, scale: 0 }).notNull(),
    turnover: numeric("turnover", { precision: 20, scale: 2 }).notNull(),
    bestBid: numeric("best_bid", { precision: 14, scale: 2 }),
    bestOffer: numeric("best_offer", { precision: 14, scale: 2 }),
    spread: numeric("spread", { precision: 14, scale: 2 }),
    isSuspended: boolean("is_suspended").notNull().default(false),
    rawPayloadId: text("raw_payload_id").references(() => rawPayloadArchive.id)
  },
  (t) => ({
    symbolDateIdx: index("market_snapshot_symbol_date_idx").on(t.symbol, t.tradingDate),
    receivedIdx: index("market_snapshot_received_idx").on(t.receivedAt)
  })
);

/**
 * True daily OHLCV bars sourced from `/api/history/{code}` (blueprint §3
 * "OHLCV dan baseline volume"). Distinct from `market_snapshot`, which is a
 * point-in-time screener poll (a single price sample per fetch, not a
 * session's open/high/low) — `daily_bar` is what the backtest/replay engine
 * (`packages/backtest`) needs for accurate gap detection and same-bar
 * SL/TP-priority resolution; `market_snapshot` alone silently collapses
 * every bar to a single price point when used as a replay data source.
 */
export const dailyBar = pgTable(
  "daily_bar",
  {
    id: text("id").primaryKey(), // uuid
    symbol: text("symbol").notNull(),
    tradingDate: text("trading_date").notNull(), // YYYY-MM-DD
    open: numeric("open", { precision: 14, scale: 2 }).notNull(),
    high: numeric("high", { precision: 14, scale: 2 }).notNull(),
    low: numeric("low", { precision: 14, scale: 2 }).notNull(),
    close: numeric("close", { precision: 14, scale: 2 }).notNull(),
    volume: numeric("volume", { precision: 20, scale: 0 }).notNull(),
    turnover: numeric("turnover", { precision: 20, scale: 2 }),
    source: text("source").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull()
  },
  (t) => ({
    symbolDateIdx: uniqueIndex("daily_bar_symbol_date_idx").on(t.symbol, t.tradingDate)
  })
);

export const brokerSnapshot = pgTable(
  "broker_snapshot",
  {
    id: text("id").primaryKey(), // uuid
    symbol: text("symbol").notNull(),
    tradingDate: text("trading_date").notNull(),
    brokerCode: text("broker_code").notNull(),
    segment: text("segment").notNull(),
    buyVolume: numeric("buy_volume", { precision: 20, scale: 0 }).notNull(),
    buyValue: numeric("buy_value", { precision: 20, scale: 2 }).notNull(),
    sellVolume: numeric("sell_volume", { precision: 20, scale: 0 }).notNull(),
    sellValue: numeric("sell_value", { precision: 20, scale: 2 }).notNull(),
    netVolume: numeric("net_volume", { precision: 20, scale: 0 }).notNull(),
    netValue: numeric("net_value", { precision: 20, scale: 2 }).notNull(),
    avgBuyPrice: numeric("avg_buy_price", { precision: 14, scale: 2 }),
    avgSellPrice: numeric("avg_sell_price", { precision: 14, scale: 2 }),
    status: text("status").notNull(), // final | provisional
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    rawPayloadId: text("raw_payload_id").references(() => rawPayloadArchive.id)
  },
  (t) => ({
    symbolDateBrokerIdx: uniqueIndex("broker_snapshot_symbol_date_broker_idx").on(
      t.symbol,
      t.tradingDate,
      t.brokerCode
    )
  })
);

export const featureSnapshot = pgTable(
  "feature_snapshot",
  {
    id: text("id").primaryKey(), // uuid
    symbol: text("symbol").notNull(),
    tradingDate: text("trading_date").notNull(),
    formulaVersion: text("formula_version").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    inputSnapshotId: text("input_snapshot_id").notNull(),
    features: jsonb("features").notNull(), // FeatureSnapshot (minus id fields) from @idx/domain
    ownerStatus: text("owner_status").notNull().default("UNVERIFIED"),
    dataStale: boolean("data_stale").notNull().default(false),
    segmentMixed: boolean("segment_mixed").notNull().default(false)
  },
  (t) => ({
    symbolDateIdx: uniqueIndex("feature_snapshot_symbol_date_idx").on(t.symbol, t.tradingDate)
  })
);

export const signal = pgTable(
  "signal",
  {
    id: text("id").primaryKey(), // uuid
    symbol: text("symbol").notNull(),
    tradingDate: text("trading_date").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    expiry: timestamp("expiry", { withTimezone: true }).notNull(),
    category: text("category").notNull(),
    compositeScore: numeric("composite_score", { precision: 6, scale: 2 }).notNull(),
    confidence: text("confidence").notNull(),
    noTradeReason: text("no_trade_reason"),
    gates: jsonb("gates").notNull(),
    formulaVersion: text("formula_version").notNull(),
    configVersion: text("config_version").notNull(),
    inputSnapshotId: text("input_snapshot_id").notNull(),
    featureSnapshotId: text("feature_snapshot_id").references(() => featureSnapshot.id)
  },
  (t) => ({
    symbolDateIdx: uniqueIndex("signal_symbol_date_idx").on(t.symbol, t.tradingDate),
    generatedIdx: index("signal_generated_idx").on(t.generatedAt)
  })
);

export const tradePlan = pgTable(
  "trade_plan",
  {
    id: text("id").primaryKey(), // uuid
    signalId: text("signal_id")
      .notNull()
      .references(() => signal.id),
    symbol: text("symbol").notNull(),
    tradingDate: text("trading_date").notNull(),
    formulaVersion: text("formula_version").notNull(),
    configVersion: text("config_version").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    expiry: timestamp("expiry", { withTimezone: true }).notNull(),
    entryTrigger: numeric("entry_trigger", { precision: 14, scale: 2 }).notNull(),
    maxBuyPrice: numeric("max_buy_price", { precision: 14, scale: 2 }).notNull(),
    totalLots: integer("total_lots").notNull(),
    estimatedCapital: numeric("estimated_capital", { precision: 14, scale: 2 }).notNull(),
    tp1Price: numeric("tp1_price", { precision: 14, scale: 2 }).notNull(),
    tp1Lots: integer("tp1_lots").notNull(),
    tp2Price: numeric("tp2_price", { precision: 14, scale: 2 }).notNull(),
    tp2Lots: integer("tp2_lots").notNull(),
    slPrice: numeric("sl_price", { precision: 14, scale: 2 }).notNull(),
    slRemainingLots: integer("sl_remaining_lots").notNull(),
    grossReward: numeric("gross_reward", { precision: 14, scale: 2 }).notNull(),
    estimatedFees: numeric("estimated_fees", { precision: 14, scale: 2 }).notNull(),
    slippageAllowance: numeric("slippage_allowance", { precision: 14, scale: 2 }).notNull(),
    netReward: numeric("net_reward", { precision: 14, scale: 2 }).notNull(),
    maxNetLoss: numeric("max_net_loss", { precision: 14, scale: 2 }).notNull(),
    netRewardToRisk: numeric("net_reward_to_risk", { precision: 8, scale: 3 }).notNull(),
    isNoTrade: boolean("is_no_trade").notNull().default(false),
    noTradeReason: text("no_trade_reason")
  },
  (t) => ({
    signalIdx: uniqueIndex("trade_plan_signal_idx").on(t.signalId)
  })
);

export const paperTrade = pgTable(
  "paper_trade",
  {
    id: text("id").primaryKey(), // uuid
    tradePlanId: text("trade_plan_id").references(() => tradePlan.id),
    symbol: text("symbol").notNull(),
    plannedEntry: numeric("planned_entry", { precision: 14, scale: 2 }).notNull(),
    actualFillPrice: numeric("actual_fill_price", { precision: 14, scale: 2 }),
    actualFillLots: integer("actual_fill_lots"),
    fillStatus: text("fill_status").notNull().default("pending"), // pending|filled|partial|no_fill|expired
    exitPrice: numeric("exit_price", { precision: 14, scale: 2 }),
    exitLots: integer("exit_lots"),
    exitReason: text("exit_reason"), // tp1|tp2|sl|manual|expiry
    actualFeePaid: numeric("actual_fee_paid", { precision: 14, scale: 2 }),
    actualSlippage: numeric("actual_slippage", { precision: 14, scale: 2 }),
    netResult: numeric("net_result", { precision: 14, scale: 2 }),
    overrideReason: text("override_reason"), // why user deviated from the plan, if any
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true })
  },
  (t) => ({
    symbolIdx: index("paper_trade_symbol_idx").on(t.symbol)
  })
);

export const strategyConfigTable = pgTable("strategy_config", {
  version: text("version").primaryKey(),
  formulaVersion: text("formula_version").notNull(),
  config: jsonb("config").notNull(), // StrategyConfig from @idx/config
  isActive: boolean("is_active").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by")
});

export const requestLedger = pgTable(
  "request_ledger",
  {
    id: text("id").primaryKey(), // uuid
    endpoint: text("endpoint").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull(), // success|error|cache_hit
    latencyMs: integer("latency_ms"),
    cacheHit: boolean("cache_hit").notNull().default(false),
    dayBucket: text("day_bucket").notNull() // YYYY-MM-DD for fast daily counting
  },
  (t) => ({
    dayBucketIdx: index("request_ledger_day_bucket_idx").on(t.dayBucket),
    endpointIdx: index("request_ledger_endpoint_idx").on(t.endpoint, t.dayBucket)
  })
);

export const alertLog = pgTable(
  "alert_log",
  {
    id: text("id").primaryKey(), // uuid
    idempotencyKey: text("idempotency_key").notNull(),
    symbol: text("symbol").notNull(),
    alertType: text("alert_type").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true })
  },
  (t) => ({
    idempotencyIdx: uniqueIndex("alert_log_idempotency_idx").on(t.idempotencyKey)
  })
);

export const sessionCalendarOverride = pgTable("session_calendar_override", {
  date: text("date").primaryKey(), // YYYY-MM-DD
  isTradingDay: boolean("is_trading_day").notNull(),
  note: text("note")
});

/**
 * Shadow-mode plans (blueprint non-goal: forward-test before real capital).
 * Every EOD the worker writes: a `live` mirror of each real deep-funnel trade
 * plan, plus `baseline_volume` / `baseline_random` plans over the same
 * enriched candidate pool. A forward evaluator fills in the outcome columns
 * once ~3 trading days of `daily_bar` history exist after the plan date.
 * This is how "does the broker-flow signal beat the baselines?" gets
 * answered — the question the backtest (Phase 0b) could not reach.
 */
export const shadowPlan = pgTable(
  "shadow_plan",
  {
    id: text("id").primaryKey(), // uuid
    tradingDate: text("trading_date").notNull(), // YYYY-MM-DD
    symbol: text("symbol").notNull(),
    source: text("source").notNull(), // live | baseline_volume | baseline_random
    category: text("category"), // signal category for the `live` source, else null
    compositeScore: numeric("composite_score", { precision: 6, scale: 2 }),
    configVersion: text("config_version").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    expiry: timestamp("expiry", { withTimezone: true }).notNull(),
    entryTrigger: numeric("entry_trigger", { precision: 14, scale: 2 }).notNull(),
    maxBuyPrice: numeric("max_buy_price", { precision: 14, scale: 2 }).notNull(),
    slPrice: numeric("sl_price", { precision: 14, scale: 2 }).notNull(),
    tp1Price: numeric("tp1_price", { precision: 14, scale: 2 }).notNull(),
    tp1Lots: integer("tp1_lots").notNull(),
    tp2Price: numeric("tp2_price", { precision: 14, scale: 2 }).notNull(),
    tp2Lots: integer("tp2_lots").notNull(),
    totalLots: integer("total_lots").notNull(),
    netRewardToRisk: numeric("net_reward_to_risk", { precision: 8, scale: 3 }).notNull(),
    isNoTrade: boolean("is_no_trade").notNull().default(false),
    planJson: jsonb("plan_json").notNull(), // full TradePlan from @idx/domain, for the forward simulator
    // --- outcome (filled forward by the evaluator) ---
    outcomeStatus: text("outcome_status"), // null=pending | no_fill | filled | partial
    filledLots: integer("filled_lots"),
    firstExitReason: text("first_exit_reason"), // tp1 | tp2 | sl | expiry
    netPnl: numeric("net_pnl", { precision: 16, scale: 2 }),
    barsHeld: integer("bars_held"),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true })
  },
  (t) => ({
    dateSourceSymbolIdx: uniqueIndex("shadow_plan_date_source_symbol_idx").on(t.tradingDate, t.source, t.symbol),
    pendingIdx: index("shadow_plan_pending_idx").on(t.outcomeStatus, t.tradingDate)
  })
);
