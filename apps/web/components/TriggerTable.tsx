"use client";

import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { SignalListItem } from "../lib/types";
import { categoryBadge } from "../lib/category";
import { formatAge, formatNumber, formatRatio, formatRupiah } from "../lib/format";
import { useUiStore } from "../store/uiStore";
import { toneClassName } from "./tone";
import { StaleRowNotice } from "./StatePanels";

const ROW_HEIGHT = 44;

export function TriggerTable({ signals }: { signals: SignalListItem[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const categoryFilter = useUiStore((s) => s.categoryFilter);
  const sortKey = useUiStore((s) => s.sortKey);
  const sortDirection = useUiStore((s) => s.sortDirection);
  const setSort = useUiStore((s) => s.setSort);
  const openDrawer = useUiStore((s) => s.openDrawer);
  const selectedSymbol = useUiStore((s) => s.selectedSymbol);

  const rows = useMemo(() => {
    let filtered = categoryFilter.size > 0 ? signals.filter((s) => categoryFilter.has(s.category)) : signals;
    filtered = [...filtered].sort((a, b) => {
      const dir = sortDirection === "asc" ? 1 : -1;
      switch (sortKey) {
        case "symbol":
          return dir * a.symbol.localeCompare(b.symbol);
        case "generatedAt":
          return dir * (new Date(a.generatedAt).getTime() - new Date(b.generatedAt).getTime());
        case "netRR":
          return dir * ((a.plan?.netRewardToRisk ?? -Infinity) - (b.plan?.netRewardToRisk ?? -Infinity));
        case "score":
        default:
          return dir * (a.compositeScore - b.compositeScore);
      }
    });
    return filtered;
  }, [signals, categoryFilter, sortKey, sortDirection]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10
  });

  function headerButton(key: typeof sortKey, label: string) {
    const active = sortKey === key;
    return (
      <button className={`th-sort ${active ? "th-sort-active" : ""}`} onClick={() => setSort(key)}>
        {label}
        {active ? (sortDirection === "desc" ? " ▼" : " ▲") : ""}
      </button>
    );
  }

  return (
    <div className="trigger-table-wrap">
      <div className="trigger-table-header">
        <div className="col col-symbol">{headerButton("symbol", "Symbol")}</div>
        <div className="col col-score">{headerButton("score", "Score")}</div>
        <div className="col col-category">Category</div>
        <div className="col col-entry">Entry</div>
        <div className="col col-lots">Lots</div>
        <div className="col col-tp">TP1</div>
        <div className="col col-tp">TP2</div>
        <div className="col col-sl">SL</div>
        <div className="col col-rr">{headerButton("netRR", "Net RR")}</div>
        <div className="col col-expiry">{headerButton("generatedAt", "Age / Expiry")}</div>
        <div className="col col-flags">Flags</div>
      </div>

      <div ref={parentRef} className="trigger-table-body">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            const badge = categoryBadge(row.category);
            const disablePlan = row.dataStale || !row.plan || row.plan.isNoTrade;
            const flagList = Object.entries(row.flags)
              .filter(([, v]) => v)
              .map(([k]) => k);

            return (
              <div
                key={row.symbol}
                className={`trigger-row ${row.symbol === selectedSymbol ? "trigger-row-selected" : ""} ${row.dataStale ? "trigger-row-stale" : ""}`}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: ROW_HEIGHT,
                  transform: `translateY(${virtualRow.start}px)`
                }}
                onClick={() => openDrawer(row.symbol)}
                role="button"
                tabIndex={0}
              >
                <div className="col col-symbol">
                  <strong>{row.symbol}</strong>
                  {row.dataStale ? <StaleRowNotice /> : null}
                </div>
                <div className="col col-score">{row.compositeScore.toFixed(1)}</div>
                <div className="col col-category">
                  <span className={toneClassName(badge.tone)}>{badge.label}</span>
                </div>
                <div className="col col-entry">{row.plan ? formatRupiah(row.plan.entryTrigger) : "—"}</div>
                <div className="col col-lots">{row.plan ? formatNumber(row.plan.totalLots) : "—"}</div>
                <div className="col col-tp">
                  {row.plan ? `${formatRupiah(row.plan.tp1Price)} ×${row.plan.tp1Lots}` : "—"}
                </div>
                <div className="col col-tp">
                  {row.plan ? `${formatRupiah(row.plan.tp2Price)} ×${row.plan.tp2Lots}` : "—"}
                </div>
                <div className="col col-sl">{row.plan ? formatRupiah(row.plan.slPrice) : "—"}</div>
                <div className="col col-rr">{row.plan ? formatRatio(row.plan.netRewardToRisk) : "—"}</div>
                <div className="col col-expiry">
                  <span title={row.expiry}>{formatAge(row.generatedAt)} old</span>
                </div>
                <div className="col col-flags">
                  {flagList.length > 0 ? (
                    flagList.map((f) => (
                      <span key={f} className="flag-chip" title={f}>
                        {f}
                      </span>
                    ))
                  ) : (
                    <span className="flag-chip flag-chip-clean">clean</span>
                  )}
                  {disablePlan ? <span className="flag-chip flag-chip-disabled">plan disabled</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
