CREATE TABLE IF NOT EXISTS "alert_log" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"symbol" text NOT NULL,
	"alert_type" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cooldown_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "broker_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"trading_date" text NOT NULL,
	"broker_code" text NOT NULL,
	"segment" text NOT NULL,
	"buy_volume" numeric(20, 0) NOT NULL,
	"buy_value" numeric(20, 2) NOT NULL,
	"sell_volume" numeric(20, 0) NOT NULL,
	"sell_value" numeric(20, 2) NOT NULL,
	"net_volume" numeric(20, 0) NOT NULL,
	"net_value" numeric(20, 2) NOT NULL,
	"avg_buy_price" numeric(14, 2),
	"avg_sell_price" numeric(14, 2),
	"status" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"raw_payload_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feature_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"trading_date" text NOT NULL,
	"formula_version" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"input_snapshot_id" text NOT NULL,
	"features" jsonb NOT NULL,
	"owner_status" text DEFAULT 'UNVERIFIED' NOT NULL,
	"data_stale" boolean DEFAULT false NOT NULL,
	"segment_mixed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "instrument" (
	"symbol" text PRIMARY KEY NOT NULL,
	"board" text,
	"sector" text,
	"shares_outstanding" numeric(20, 0),
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "market_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"trading_date" text NOT NULL,
	"event_time" timestamp with time zone,
	"published_at" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"segment" text NOT NULL,
	"revision_id" text,
	"status" text NOT NULL,
	"price" numeric(14, 2) NOT NULL,
	"price_change_pct" numeric(8, 4),
	"volume" numeric(20, 0) NOT NULL,
	"turnover" numeric(20, 2) NOT NULL,
	"best_bid" numeric(14, 2),
	"best_offer" numeric(14, 2),
	"spread" numeric(14, 2),
	"is_suspended" boolean DEFAULT false NOT NULL,
	"raw_payload_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "paper_trade" (
	"id" text PRIMARY KEY NOT NULL,
	"trade_plan_id" text,
	"symbol" text NOT NULL,
	"planned_entry" numeric(14, 2) NOT NULL,
	"actual_fill_price" numeric(14, 2),
	"actual_fill_lots" integer,
	"fill_status" text DEFAULT 'pending' NOT NULL,
	"exit_price" numeric(14, 2),
	"exit_lots" integer,
	"exit_reason" text,
	"actual_fee_paid" numeric(14, 2),
	"actual_slippage" numeric(14, 2),
	"net_result" numeric(14, 2),
	"override_reason" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raw_payload_archive" (
	"id" text PRIMARY KEY NOT NULL,
	"endpoint" text NOT NULL,
	"symbol" text,
	"requested_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"http_status" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"schema_valid" boolean NOT NULL,
	"schema_errors" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "request_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"endpoint" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"latency_ms" integer,
	"cache_hit" boolean DEFAULT false NOT NULL,
	"day_bucket" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session_calendar_override" (
	"date" text PRIMARY KEY NOT NULL,
	"is_trading_day" boolean NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signal" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"trading_date" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"expiry" timestamp with time zone NOT NULL,
	"category" text NOT NULL,
	"composite_score" numeric(6, 2) NOT NULL,
	"confidence" text NOT NULL,
	"no_trade_reason" text,
	"gates" jsonb NOT NULL,
	"formula_version" text NOT NULL,
	"config_version" text NOT NULL,
	"input_snapshot_id" text NOT NULL,
	"feature_snapshot_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "strategy_config" (
	"version" text PRIMARY KEY NOT NULL,
	"formula_version" text NOT NULL,
	"config" jsonb NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trade_plan" (
	"id" text PRIMARY KEY NOT NULL,
	"signal_id" text NOT NULL,
	"symbol" text NOT NULL,
	"trading_date" text NOT NULL,
	"formula_version" text NOT NULL,
	"config_version" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"expiry" timestamp with time zone NOT NULL,
	"entry_trigger" numeric(14, 2) NOT NULL,
	"max_buy_price" numeric(14, 2) NOT NULL,
	"total_lots" integer NOT NULL,
	"estimated_capital" numeric(14, 2) NOT NULL,
	"tp1_price" numeric(14, 2) NOT NULL,
	"tp1_lots" integer NOT NULL,
	"tp2_price" numeric(14, 2) NOT NULL,
	"tp2_lots" integer NOT NULL,
	"sl_price" numeric(14, 2) NOT NULL,
	"sl_remaining_lots" integer NOT NULL,
	"gross_reward" numeric(14, 2) NOT NULL,
	"estimated_fees" numeric(14, 2) NOT NULL,
	"slippage_allowance" numeric(14, 2) NOT NULL,
	"net_reward" numeric(14, 2) NOT NULL,
	"max_net_loss" numeric(14, 2) NOT NULL,
	"net_reward_to_risk" numeric(8, 3) NOT NULL,
	"is_no_trade" boolean DEFAULT false NOT NULL,
	"no_trade_reason" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "broker_snapshot" ADD CONSTRAINT "broker_snapshot_raw_payload_id_raw_payload_archive_id_fk" FOREIGN KEY ("raw_payload_id") REFERENCES "public"."raw_payload_archive"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "market_snapshot" ADD CONSTRAINT "market_snapshot_raw_payload_id_raw_payload_archive_id_fk" FOREIGN KEY ("raw_payload_id") REFERENCES "public"."raw_payload_archive"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "paper_trade" ADD CONSTRAINT "paper_trade_trade_plan_id_trade_plan_id_fk" FOREIGN KEY ("trade_plan_id") REFERENCES "public"."trade_plan"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "signal" ADD CONSTRAINT "signal_feature_snapshot_id_feature_snapshot_id_fk" FOREIGN KEY ("feature_snapshot_id") REFERENCES "public"."feature_snapshot"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trade_plan" ADD CONSTRAINT "trade_plan_signal_id_signal_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signal"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "alert_log_idempotency_idx" ON "alert_log" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "broker_snapshot_symbol_date_broker_idx" ON "broker_snapshot" USING btree ("symbol","trading_date","broker_code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "feature_snapshot_symbol_date_idx" ON "feature_snapshot" USING btree ("symbol","trading_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "market_snapshot_symbol_date_idx" ON "market_snapshot" USING btree ("symbol","trading_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "market_snapshot_received_idx" ON "market_snapshot" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "paper_trade_symbol_idx" ON "paper_trade" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "raw_payload_endpoint_idx" ON "raw_payload_archive" USING btree ("endpoint","received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "raw_payload_symbol_idx" ON "raw_payload_archive" USING btree ("symbol","received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_ledger_day_bucket_idx" ON "request_ledger" USING btree ("day_bucket");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_ledger_endpoint_idx" ON "request_ledger" USING btree ("endpoint","day_bucket");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_symbol_date_idx" ON "signal" USING btree ("symbol","trading_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_generated_idx" ON "signal" USING btree ("generated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trade_plan_signal_idx" ON "trade_plan" USING btree ("signal_id");