CREATE TABLE IF NOT EXISTS "shadow_plan" (
	"id" text PRIMARY KEY NOT NULL,
	"trading_date" text NOT NULL,
	"symbol" text NOT NULL,
	"source" text NOT NULL,
	"category" text,
	"composite_score" numeric(6, 2),
	"config_version" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"expiry" timestamp with time zone NOT NULL,
	"entry_trigger" numeric(14, 2) NOT NULL,
	"max_buy_price" numeric(14, 2) NOT NULL,
	"sl_price" numeric(14, 2) NOT NULL,
	"tp1_price" numeric(14, 2) NOT NULL,
	"tp1_lots" integer NOT NULL,
	"tp2_price" numeric(14, 2) NOT NULL,
	"tp2_lots" integer NOT NULL,
	"total_lots" integer NOT NULL,
	"net_reward_to_risk" numeric(8, 3) NOT NULL,
	"is_no_trade" boolean DEFAULT false NOT NULL,
	"plan_json" jsonb NOT NULL,
	"outcome_status" text,
	"filled_lots" integer,
	"first_exit_reason" text,
	"net_pnl" numeric(16, 2),
	"bars_held" integer,
	"evaluated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shadow_plan_date_source_symbol_idx" ON "shadow_plan" USING btree ("trading_date","source","symbol");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shadow_plan_pending_idx" ON "shadow_plan" USING btree ("outcome_status","trading_date");