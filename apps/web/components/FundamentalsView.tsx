"use client";

import { useState } from "react";
import { useFundamentals } from "../lib/hooks";
import { LoadingState, ErrorState } from "./StatePanels";
import type { FundamentalCategory, FundamentalRow, FundamentalsResponse } from "../lib/types";

const CATEGORY_LABEL: Record<FundamentalCategory, string> = {
  growth: "Growth",
  value: "Value",
  quality: "Quality",
  hidden_gem: "Hidden gem",
  caution: "Caution"
};

const CATEGORY_BLURB: Record<FundamentalCategory, string> = {
  growth: "Earnings growth (YoY) in the top third of the universe, and positive.",
  value: "Cheap relative to book value (top third) AND currently profitable — not cheap because something is broken.",
  quality: "Hygiene only: trailing 4-quarter net income > 0, operating cash flow > 0, ROE > 0.",
  hidden_gem: "Quality AND Value AND below-median market cap AND hasn't rallied yet (below-median 20-day return) — fundamentally fine, cheap, small, still under the radar on price.",
  caution: "The mirror image: a top-decile 20-day price rally WITHOUT earnings growth or quality behind it — priced up without fundamentals to support it."
};

const CATEGORY_ORDER: FundamentalCategory[] = ["hidden_gem", "growth", "value", "quality", "caution"];

function pct(n: number | null, d = 1): string {
  return n === null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(d)}%`;
}
function num(n: number | null, d = 1): string {
  return n === null || !Number.isFinite(n) ? "—" : n.toFixed(d);
}
function rupiahCompact(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n >= 1e12) return `Rp${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9) return `Rp${(n / 1e9).toFixed(1)}M`;
  return `Rp${Math.round(n).toLocaleString("id-ID")}`;
}

function CategoryTable({ rows }: { rows: FundamentalRow[] }) {
  if (rows.length === 0) return <p className="fundamentals-empty">No names in this category today.</p>;
  return (
    <div className="journal-table-wrap">
      <table className="journal-table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Sector</th>
            <th>Price (as of)</th>
            <th>Mkt cap</th>
            <th>ROE</th>
            <th>NI YoY</th>
            <th>P/E (TTM)</th>
            <th>P/B</th>
            <th>20d ret</th>
            <th>Quality</th>
            <th>Analyst</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.symbol}>
              <td>{r.symbol}</td>
              <td>{r.sector ?? "—"}</td>
              <td>
                {r.close.toLocaleString("id-ID")} <span className="price-as-of">({r.priceAsOf})</span>
              </td>
              <td>{rupiahCompact(r.marketCap)}</td>
              <td>{pct(r.roe)}</td>
              <td>{pct(r.niYoy)}</td>
              <td>{num(r.trailingPE)}</td>
              <td>{num(r.priceToBook)}</td>
              <td className={r.ret20 !== null && r.ret20 !== 0 ? (r.ret20 > 0 ? "positive-result" : "negative-result") : ""}>
                {pct(r.ret20)}
              </td>
              <td>{r.quality === null ? "n/a" : r.quality ? "yes" : "no"}</td>
              <td>{r.recommendationKey ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FundamentalsBody({ data }: { data: FundamentalsResponse }) {
  const [tab, setTab] = useState<FundamentalCategory>("hidden_gem");
  const symbols = data.categories[tab] ?? [];
  const rows = symbols.map((s) => data.rows[s]).filter((r): r is FundamentalRow => !!r);

  return (
    <div className="fundamentals-view">
      <p className="shadow-intro">
        <strong>Descriptive categorization, not a trading signal.</strong> Phase 0I tested
        profitability, value and size factors on this exact dataset and found no fundamental
        factor that reliably predicts IDX returns (see <code>docs/BACKTEST_PHASE0I.md</code>) —
        book-to-price was the only one with a consistent sign, and even that was weak. These
        tabs describe what kind of company a stock <em>is</em> today (cheap, profitable, growing,
        under-the-radar, or rallying without earnings behind it) — they are not a claim that any
        group will outperform. Universe: {data.universe} liquid names, most recent price data
        {" "}{data.asOf ?? "—"} (fundamentals available for {data.coverage.fundamentals}, Yahoo
        Finance data for {data.coverage.yfinance}). Not every name refreshes daily — the live
        worker only updates the handful of stocks that reach its deep-funnel screen each session,
        the rest come from periodic bulk backfills — so each row shows its own price date; prices
        up to 10 days old are still shown, older ones are dropped.
      </p>

      <nav className="view-tabs">
        {CATEGORY_ORDER.map((c) => (
          <button key={c} className={tab === c ? "tab-active" : ""} onClick={() => setTab(c)}>
            {CATEGORY_LABEL[c]} ({data.categories[c]?.length ?? 0})
          </button>
        ))}
      </nav>

      <p className="fundamentals-blurb">{CATEGORY_BLURB[tab]}</p>

      <CategoryTable rows={rows} />
    </div>
  );
}

export function FundamentalsView() {
  const q = useFundamentals();

  if (q.isLoading) return <LoadingState />;
  if (q.isError || !q.data)
    return (
      <ErrorState
        message={q.error instanceof Error ? q.error.message : "Failed to load fundamentals"}
        onRetry={() => q.refetch()}
      />
    );

  return <FundamentalsBody data={q.data} />;
}
