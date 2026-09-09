import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb } from "../../../lib/db";
import { schema } from "@idx/db";
import type { PaperTradeView } from "../../../lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function toView(row: typeof schema.paperTrade.$inferSelect): PaperTradeView {
  return {
    id: row.id,
    tradePlanId: row.tradePlanId,
    symbol: row.symbol,
    plannedEntry: Number(row.plannedEntry),
    actualFillPrice: row.actualFillPrice === null ? null : Number(row.actualFillPrice),
    actualFillLots: row.actualFillLots,
    fillStatus: row.fillStatus as PaperTradeView["fillStatus"],
    exitPrice: row.exitPrice === null ? null : Number(row.exitPrice),
    exitLots: row.exitLots,
    exitReason: row.exitReason as PaperTradeView["exitReason"],
    actualFeePaid: row.actualFeePaid === null ? null : Number(row.actualFeePaid),
    actualSlippage: row.actualSlippage === null ? null : Number(row.actualSlippage),
    netResult: row.netResult === null ? null : Number(row.netResult),
    overrideReason: row.overrideReason,
    openedAt: new Date(row.openedAt).toISOString(),
    closedAt: row.closedAt ? new Date(row.closedAt).toISOString() : null
  };
}

/** GET /api/journal — list paper trades, newest first. ?symbol= to filter. */
export async function GET(req: NextRequest) {
  try {
    const db = getDb();
    const symbol = new URL(req.url).searchParams.get("symbol");
    const rows = symbol
      ? await db
          .select()
          .from(schema.paperTrade)
          .where(eq(schema.paperTrade.symbol, symbol.toUpperCase()))
          .orderBy(desc(schema.paperTrade.openedAt))
      : await db.select().from(schema.paperTrade).orderBy(desc(schema.paperTrade.openedAt)).limit(500);

    return NextResponse.json({ trades: rows.map(toView) });
  } catch (err) {
    return NextResponse.json(
      { error: "journal_list_failed", message: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

const createSchema = z.object({
  symbol: z.string().min(1),
  tradePlanId: z.string().nullable().optional(),
  plannedEntry: z.number(),
  overrideReason: z.string().nullable().optional()
});

/**
 * POST /api/journal — record a new paper trade: either "plan followed"
 * (tradePlanId set, overrideReason omitted) or "plan overridden" (the user
 * deviated from the plan; overrideReason is required in that case by
 * convention, though not DB-enforced, per blueprint §13.3's audit trail).
 */
export async function POST(req: NextRequest) {
  try {
    const db = getDb();
    const json = await req.json();
    const parsed = createSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
    }
    const input = parsed.data;

    const [row] = await db
      .insert(schema.paperTrade)
      .values({
        id: randomUUID(),
        tradePlanId: input.tradePlanId ?? null,
        symbol: input.symbol.toUpperCase(),
        plannedEntry: String(input.plannedEntry),
        fillStatus: "pending",
        overrideReason: input.overrideReason ?? null
      })
      .returning();

    if (!row) {
      return NextResponse.json({ error: "insert_failed" }, { status: 500 });
    }

    return NextResponse.json({ trade: toView(row) }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "journal_create_failed", message: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
