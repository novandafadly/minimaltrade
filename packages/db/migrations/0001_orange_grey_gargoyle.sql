CREATE TABLE IF NOT EXISTS "daily_bar" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"trading_date" text NOT NULL,
	"open" numeric(14, 2) NOT NULL,
	"high" numeric(14, 2) NOT NULL,
	"low" numeric(14, 2) NOT NULL,
	"close" numeric(14, 2) NOT NULL,
	"volume" numeric(20, 0) NOT NULL,
	"turnover" numeric(20, 2),
	"source" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "daily_bar_symbol_date_idx" ON "daily_bar" USING btree ("symbol","trading_date");