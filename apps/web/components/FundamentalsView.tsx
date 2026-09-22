"use client";

import { useState } from "react";
import { useFundamentals } from "../lib/hooks";
import { LoadingState, ErrorState } from "./StatePanels";
import type { FundamentalCategory, FundamentalRow, FundamentalsResponse } from "../lib/types";

const CATEGORY_LABEL: Record<FundamentalCategory, string> = {
  best_overall: "Best of the best",
  growth: "Growth",
  value: "Value",
  quality: "Quality",
  hidden_gem: "Hidden gem",
  caution: "Caution"
};

const CATEGORY_BLURB: Record<FundamentalCategory, string> = {
  best_overall:
    "Not another independent flag — a single composite rank (mean percentile of ROE, book-to-price, earnings-to-price and NI growth) among Quality-passing names that have ALL four numbers available, sorted best-first. Scores well across value, quality AND growth at once, not just one of them — capped to the top 15.",
  growth:
    "Revenue growth (YoY) in the top third of the universe AND positive, AND earnings also growing — revenue is the primary signal now (steadier than net income alone, which a one-off gain or loss can swing). Non-bank only: ARJUM has no single revenue line for banks in this format.",
  value: "Cheap relative to book value (top third) AND currently profitable — not cheap because something is broken.",
  quality:
    "Hygiene only: trailing 4-quarter net income > 0, operating cash flow > 0, ROE > 0, and (non-banks only) debt-to-equity not excessive — a thin equity base can inflate ROE without the business actually being more productive.",
  hidden_gem: "Quality AND Value AND below-median market cap AND hasn't rallied yet (below-median 20-day return) — fundamentally fine, cheap, small, still under the radar on price.",
  caution: "The mirror image: a top-decile 20-day price rally WITHOUT earnings growth or quality behind it — priced up without fundamentals to support it."
};

const CATEGORY_ORDER: FundamentalCategory[] = ["best_overall", "hidden_gem", "growth", "value", "quality", "caution"];

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
            <th>Score</th>
            <th>Sector</th>
            <th>Price (as of)</th>
            <th>Mkt cap</th>
            <th>ROE</th>
            <th>DER</th>
            <th>Rev YoY</th>
            <th>NI YoY</th>
            <th>Margin Δ (YoY)</th>
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
              <td>
                {r.symbol}
                {r.isBank ? <span className="price-as-of"> (bank)</span> : null}
              </td>
              <td>{r.compositeScore === null ? "—" : r.compositeScore.toFixed(0)}</td>
              <td>{r.sector ?? "—"}</td>
              <td>
                {r.close.toLocaleString("id-ID")} <span className="price-as-of">({r.priceAsOf})</span>
              </td>
              <td>{rupiahCompact(r.marketCap)}</td>
              <td>{pct(r.roe)}</td>
              <td>{r.isBank ? "n/a (bank)" : num(r.der, 2)}</td>
              <td>{r.isBank ? "n/a (bank)" : pct(r.revYoy)}</td>
              <td>{pct(r.niYoy)}</td>
              <td
                className={
                  r.marginTrendPP !== null && r.marginTrendPP !== 0
                    ? r.marginTrendPP > 0
                      ? "positive-result"
                      : "negative-result"
                    : ""
                }
              >
                {r.isBank ? "n/a (bank)" : r.marginTrendPP === null ? "—" : `${r.marginTrendPP >= 0 ? "+" : ""}${(r.marginTrendPP * 100).toFixed(1)}pp`}
              </td>
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
  const [tab, setTab] = useState<FundamentalCategory>("best_overall");
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
        up to 10 days old are still shown, older ones are dropped. ROE, book-to-price,
        earnings-to-price and earnings growth are ranked against each stock's own peer group
        (banks vs everyone else) — banks' financial statements are structured completely
        differently and their ratios aren't comparable to industrials or consumer names, so
        a bank is only ranked against other banks. Debt-to-equity is shown for context but
        not applied to banks (leverage is structural to how banks operate). Revenue growth
        and the margin trend (gross margin vs a year ago) are also non-bank only — ARJUM
        doesn't expose a single revenue/cost-of-sales line for banks in this format. Margin
        trend is informational only: unlike debt-to-equity, there's no tested threshold for
        how much margin compression should disqualify a name, so it isn't gated.
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
