-- Dedupe existing rows before the unique indexes can be created. Duplicate
-- (symbol, trading_date) signals (and their trade plans) accumulated because
-- insertSignal/insertTradePlan were plain inserts and the deep funnel can
-- re-run (e.g. worker restart). Keep the most-recently-generated row of each.
DELETE FROM "trade_plan" WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (PARTITION BY "signal_id" ORDER BY "generated_at" DESC, "id") AS rn
    FROM "trade_plan"
  ) x WHERE x.rn > 1
);--> statement-breakpoint
DELETE FROM "trade_plan" WHERE "signal_id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (PARTITION BY "symbol", "trading_date" ORDER BY "generated_at" DESC, "id") AS rn
    FROM "signal"
  ) x WHERE x.rn > 1
);--> statement-breakpoint
DELETE FROM "signal" WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (PARTITION BY "symbol", "trading_date" ORDER BY "generated_at" DESC, "id") AS rn
    FROM "signal"
  ) x WHERE x.rn > 1
);--> statement-breakpoint
DROP INDEX IF EXISTS "signal_symbol_date_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "trade_plan_signal_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "signal_symbol_date_idx" ON "signal" USING btree ("symbol","trading_date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trade_plan_signal_idx" ON "trade_plan" USING btree ("signal_id");
