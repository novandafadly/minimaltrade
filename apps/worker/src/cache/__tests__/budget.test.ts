import { describe, expect, it } from "vitest";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { getTestDb, truncateAll } from "../../__tests__/testDb.js";
import { reserveRequest, getBudgetStatus, recordLedgerEntry } from "../budget.js";
import { BudgetExceededError } from "../../adapter/errors.js";
import { schema } from "@idx/db";
import { sql } from "drizzle-orm";

// ioredis-mock v6+ shares in-memory state across instances on the same
// host:port (to emulate multiple real clients against one server); give
// every test its own port so tests stay isolated from each other.
let portCounter = 20000;
function freshRedis(): Redis {
  portCounter += 1;
  return new RedisMock(portCounter) as unknown as Redis;
}

describe("daily request budget", () => {
  it("allows requests under the soft limit (budget - reserve)", async () => {
    const redis = freshRedis();
    const count = await reserveRequest(redis, 1000, 250, "screenerLatest");
    expect(count).toBe(1);
  });

  it("refuses a normal (non-reserve) call once the soft limit is reached, without exceeding the hard budget", async () => {
    const redis = freshRedis();
    const dailyBudget = 10;
    const dailyReserve = 3; // soft limit = 7
    for (let i = 0; i < 7; i++) {
      await reserveRequest(redis, dailyBudget, dailyReserve, "screenerLatest");
    }
    await expect(reserveRequest(redis, dailyBudget, dailyReserve, "screenerLatest")).rejects.toBeInstanceOf(
      BudgetExceededError
    );

    const status = await getBudgetStatus(redis, dailyBudget, dailyReserve);
    expect(status.currentCount).toBe(7); // the rejected attempt did not increment the counter
  });

  it("allows a manual/retry call to dip into the reserve, but never past the hard budget", async () => {
    const redis = freshRedis();
    const dailyBudget = 10;
    const dailyReserve = 3; // soft limit = 7, hard limit = 10
    for (let i = 0; i < 7; i++) {
      await reserveRequest(redis, dailyBudget, dailyReserve, "screenerLatest");
    }
    // normal caller refused now
    await expect(reserveRequest(redis, dailyBudget, dailyReserve, "screenerLatest")).rejects.toBeInstanceOf(
      BudgetExceededError
    );
    // manual/retry caller may dip into the reserve
    for (let i = 0; i < 3; i++) {
      await reserveRequest(redis, dailyBudget, dailyReserve, "insiders", { allowReserve: true });
    }
    // but the hard budget itself is never exceeded, even for allowReserve callers
    await expect(
      reserveRequest(redis, dailyBudget, dailyReserve, "insiders", { allowReserve: true })
    ).rejects.toBeInstanceOf(BudgetExceededError);

    const status = await getBudgetStatus(redis, dailyBudget, dailyReserve);
    expect(status.currentCount).toBe(10);
  });
});

describe("request ledger", () => {
  it("durably records every request attempt (success, error, cache_hit)", async () => {
    const db = getTestDb();
    await truncateAll();

    await recordLedgerEntry(db, { endpoint: "screenerLatest", status: "success", latencyMs: 120, cacheHit: false });
    await recordLedgerEntry(db, { endpoint: "screenerLatest", status: "cache_hit", latencyMs: 2, cacheHit: true });
    await recordLedgerEntry(db, { endpoint: "history", status: "error", latencyMs: 500, cacheHit: false });

    const rows = await db.select().from(schema.requestLedger).orderBy(sql`requested_at asc`);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.status).sort()).toEqual(["cache_hit", "error", "success"]);
  });
});
