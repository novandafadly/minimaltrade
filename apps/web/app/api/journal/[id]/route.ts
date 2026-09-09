import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../../../lib/db";
import { schema } from "@idx/db";
import type { PaperTradeView } from "../../../../lib/types";

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

const updateSchema = z.object({
  actualFillPrice: z.number().nullable().optional(),
  actualFillLots: z.number().int().nullable().optional(),
  fillStatus: z.enum(["pending", "filled", "partial", "no_fill", "expired"]).optional(),
  exitPrice: z.number().nullable().optional(),
  exitLots: z.number().int().nullable().optional(),
  exitReason: z.enum(["tp1", "tp2", "sl", "manual", "expiry"]).nullable().optional(),
  actualFeePaid: z.number().nullable().optional(),
  actualSlippage: z.number().nullable().optional(),
  netResult: z.number().nullable().optional(),
  overrideReason: z.string().nullable().optional(),
  closed: z.boolean().optional()
});

/**
 * PATCH /api/journal/[id] — record actual fill/exit against a planned
 * paper trade. Any subset of fields may be sent (e.g. fill first, exit
 * later). Pass closed: true to stamp closedAt.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const db = getDb();
    const json = await req.json();
    const parsed = updateSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
    }
    const input = parsed.data;

    const values: Partial<typeof schema.paperTrade.$inferInsert> = {};
    if (input.actualFillPrice !== undefined)
      values.actualFillPrice = input.actualFillPrice === null ? null : String(input.actualFillPrice);
    if (input.actualFillLots !== undefined) values.actualFillLots = input.actualFillLots;
    if (input.fillStatus !== undefined) values.fillStatus = input.fillStatus;
    if (input.exitPrice !== undefined)
      values.exitPrice = input.exitPrice === null ? null : String(input.exitPrice);
    if (input.exitLots !== undefined) values.exitLots = input.exitLots;
    if (input.exitReason !== undefined) values.exitReason = input.exitReason;
    if (input.actualFeePaid !== undefined)
      values.actualFeePaid = input.actualFeePaid === null ? null : String(input.actualFeePaid);
    if (input.actualSlippage !== undefined)
      values.actualSlippage = input.actualSlippage === null ? null : String(input.actualSlippage);
    if (input.netResult !== undefined)
      values.netResult = input.netResult === null ? null : String(input.netResult);
    if (input.overrideReason !== undefined) values.overrideReason = input.overrideReason;
    if (input.closed) values.closedAt = new Date();

    if (Object.keys(values).length === 0) {
      return NextResponse.json({ error: "no_fields_to_update" }, { status: 400 });
    }

    const [row] = await db
      .update(schema.paperTrade)
      .set(values)
      .where(eq(schema.paperTrade.id, params.id))
      .returning();

    if (!row) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    return NextResponse.json({ trade: toView(row) });
  } catch (err) {
    return NextResponse.json(
      { error: "journal_update_failed", message: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const db = getDb();
    const [row] = await db.select().from(schema.paperTrade).where(eq(schema.paperTrade.id, params.id)).limit(1);
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ trade: toView(row) });
  } catch (err) {
    return NextResponse.json(
      { error: "journal_get_failed", message: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
