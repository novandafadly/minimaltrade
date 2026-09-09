"use client";

import { useState } from "react";
import { useJournal, useUpdatePaperTrade } from "../lib/hooks";
import { formatAge, formatRupiah } from "../lib/format";
import { LoadingState, ErrorState, EmptyState } from "./StatePanels";
import type { PaperTradeView } from "../lib/types";

const FILL_STATUSES: PaperTradeView["fillStatus"][] = ["pending", "filled", "partial", "no_fill", "expired"];
const EXIT_REASONS: NonNullable<PaperTradeView["exitReason"]>[] = ["tp1", "tp2", "sl", "manual", "expiry"];

export function JournalView() {
  const { data, isLoading, isError, error, refetch } = useJournal();

  if (isLoading) return <LoadingState label="Loading journal…" />;
  if (isError) return <ErrorState message={error instanceof Error ? error.message : "Failed to load journal"} onRetry={() => refetch()} />;
  if (!data || data.trades.length === 0) {
    return <EmptyState title="No paper trades yet" detail="Log a plan from the trigger table to start the forward-test journal." />;
  }

  return (
    <div className="journal-wrap">
      <table className="journal-table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Opened</th>
            <th>Planned entry</th>
            <th>Actual fill</th>
            <th>Status</th>
            <th>Exit</th>
            <th>Net result</th>
            <th>Override reason</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data.trades.map((t) => (
            <JournalRow key={t.id} trade={t} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JournalRow({ trade }: { trade: PaperTradeView }) {
  const [editing, setEditing] = useState(false);
  const update = useUpdatePaperTrade();

  const netResultClass = trade.netResult === null ? "" : trade.netResult >= 0 ? "positive-result" : "negative-result";

  return (
    <>
      <tr>
        <td>
          <strong>{trade.symbol}</strong>
        </td>
        <td title={trade.openedAt}>{formatAge(trade.openedAt)} ago</td>
        <td>{formatRupiah(trade.plannedEntry)}</td>
        <td>
          {trade.actualFillPrice !== null
            ? `${formatRupiah(trade.actualFillPrice)} × ${trade.actualFillLots ?? "?"}`
            : "—"}
        </td>
        <td>
          <span className={`fill-status fill-status-${trade.fillStatus}`}>{trade.fillStatus}</span>
        </td>
        <td>
          {trade.exitPrice !== null ? `${formatRupiah(trade.exitPrice)} (${trade.exitReason ?? "?"})` : "—"}
        </td>
        <td className={netResultClass}>{trade.netResult !== null ? formatRupiah(trade.netResult) : "—"}</td>
        <td>{trade.overrideReason ?? <span className="state-detail">plan followed</span>}</td>
        <td>
          <button className="btn btn-secondary btn-sm" onClick={() => setEditing((v) => !v)}>
            {editing ? "Close" : "Record"}
          </button>
        </td>
      </tr>
      {editing ? (
        <tr className="journal-edit-row">
          <td colSpan={9}>
            <JournalEditForm
              trade={trade}
              onSave={(patch) => {
                update.mutate({ id: trade.id, ...patch });
                setEditing(false);
              }}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function JournalEditForm({
  trade,
  onSave
}: {
  trade: PaperTradeView;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [fillStatus, setFillStatus] = useState<PaperTradeView["fillStatus"]>(trade.fillStatus);
  const [actualFillPrice, setActualFillPrice] = useState(trade.actualFillPrice?.toString() ?? "");
  const [actualFillLots, setActualFillLots] = useState(trade.actualFillLots?.toString() ?? "");
  const [exitPrice, setExitPrice] = useState(trade.exitPrice?.toString() ?? "");
  const [exitReason, setExitReason] = useState<PaperTradeView["exitReason"]>(trade.exitReason);
  const [netResult, setNetResult] = useState(trade.netResult?.toString() ?? "");
  const [overrideReason, setOverrideReason] = useState(trade.overrideReason ?? "");

  return (
    <form
      className="journal-edit-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          fillStatus,
          actualFillPrice: actualFillPrice === "" ? null : Number(actualFillPrice),
          actualFillLots: actualFillLots === "" ? null : Number(actualFillLots),
          exitPrice: exitPrice === "" ? null : Number(exitPrice),
          exitReason: exitReason ?? null,
          netResult: netResult === "" ? null : Number(netResult),
          overrideReason: overrideReason === "" ? null : overrideReason,
          closed: exitPrice !== ""
        });
      }}
    >
      <label>
        Fill status
        <select value={fillStatus} onChange={(e) => setFillStatus(e.target.value as PaperTradeView["fillStatus"])}>
          {FILL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label>
        Actual fill price
        <input value={actualFillPrice} onChange={(e) => setActualFillPrice(e.target.value)} inputMode="decimal" />
      </label>
      <label>
        Actual fill lots
        <input value={actualFillLots} onChange={(e) => setActualFillLots(e.target.value)} inputMode="numeric" />
      </label>
      <label>
        Exit price
        <input value={exitPrice} onChange={(e) => setExitPrice(e.target.value)} inputMode="decimal" />
      </label>
      <label>
        Exit reason
        <select value={exitReason ?? ""} onChange={(e) => setExitReason((e.target.value || null) as PaperTradeView["exitReason"])}>
          <option value="">—</option>
          {EXIT_REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <label>
        Net result (Rp)
        <input value={netResult} onChange={(e) => setNetResult(e.target.value)} inputMode="decimal" />
      </label>
      <label className="journal-edit-wide">
        Override reason (why actual deviated from plan, if it did)
        <input value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
      </label>
      <button className="btn btn-primary btn-sm" type="submit">
        Save
      </button>
    </form>
  );
}
