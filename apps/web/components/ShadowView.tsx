"use client";

import { useShadow } from "../lib/hooks";
import { LoadingState, ErrorState } from "./StatePanels";
import type { ShadowSourceStats } from "../lib/types";

const SOURCE_LABEL: Record<string, string> = {
  live: "Live — ARJUM + full engine",
  screener_arjum: "Screener — ARJUM shortlist",
  screener_marketcap: "Screener — ARJUM ∩ liquidity/size",
  screener_technical: "Screener — technical breakout",
  screener_consensus: "Screener — consensus (≥2 agree)",
  baseline_volume: "Baseline — volume rank",
  baseline_random: "Baseline — random"
};

const SOURCE_ORDER = [
  "live",
  "screener_consensus",
  "screener_arjum",
  "screener_marketcap",
  "screener_technical",
  "baseline_volume",
  "baseline_random"
];

function orderSources(stats: ShadowSourceStats[]): ShadowSourceStats[] {
  return [...stats].sort((a, b) => {
    const ia = SOURCE_ORDER.indexOf(a.source);
    const ib = SOURCE_ORDER.indexOf(b.source);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

function rupiah(n: number): string {
  const sign = n < 0 ? "−" : "";
  return `${sign}Rp${Math.abs(Math.round(n)).toLocaleString("id-ID")}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function pnlClass(n: number | null): string {
  if (n === null || n === 0) return "";
  return n > 0 ? "positive-result" : "negative-result";
}

const MIN_EVAL = 20;

function verdict(stats: ShadowSourceStats[]): string {
  const by = (src: string) => stats.find((s) => s.source === src);
  const ready = (s?: ShadowSourceStats) => !!s && s.evaluated >= MIN_EVAL;

  const screeners = stats.filter((s) => s.source.startsWith("screener_"));
  const baselines = stats.filter((s) => s.source.startsWith("baseline_"));
  const live = by("live");

  const readyScreeners = screeners.filter(ready);
  if (readyScreeners.length === 0) {
    const best = screeners.reduce((m, s) => Math.max(m, s.evaluated), 0);
    return `Not enough data yet — best screener has ${best} evaluated plans, need ~${MIN_EVAL}. Keep it running (~15-30 trading days).`;
  }

  const bestScreener = readyScreeners.reduce((a, b) => (b.expectancy > a.expectancy ? b : a));
  const label = SOURCE_LABEL[bestScreener.source] ?? bestScreener.source;
  const beatsAllBaselines = baselines
    .filter(ready)
    .every((b) => bestScreener.expectancy > b.expectancy && bestScreener.profitFactor > b.profitFactor);

  if (!beatsAllBaselines) {
    return `No screener beats the random/volume baselines yet on expectancy + profit factor. The ARJUM shortlist and the technical screen are not (yet) proven to add value over picking liquid names at random.`;
  }

  let msg = `Best screener so far: ${label} (expectancy ${rupiah(bestScreener.expectancy)}/plan, PF ${bestScreener.profitFactor === Infinity ? "∞" : bestScreener.profitFactor.toFixed(2)}) — beats both baselines.`;
  if (ready(live)) {
    if (live!.expectancy > bestScreener.expectancy) {
      msg += ` The full engine (live) still beats it — the composite score is adding value on top of the screener.`;
    } else {
      msg += ` The full engine (live) does NOT beat it — the score may be over-engineered; the screener does the work.`;
    }
  }
  return msg;
}

export function ShadowView() {
  const q = useShadow();

  if (q.isLoading) return <LoadingState />;
  if (q.isError)
    return (
      <ErrorState
        message={q.error instanceof Error ? q.error.message : "Failed to load shadow results"}
        onRetry={() => q.refetch()}
      />
    );

  const stats = orderSources(q.data?.stats ?? []);
  const recent = q.data?.recent ?? [];

  return (
    <div className="shadow-view">
      <p className="shadow-intro">
        Every EOD the engine records a plan for each <strong>source</strong> over the same forward
        window: the <strong>live</strong> signal (ARJUM shortlist + full feature/scoring/risk engine),
        four candidate <strong>screeners</strong> (ARJUM raw, ARJUM ∩ liquidity/size, a technical
        breakout screen, and their consensus), and two dumb <strong>baselines</strong> (volume rank,
        random). Every non-live plan is built the same way — off OHLCV with a 5-day-low stop — so this
        isolates <em>which shortlist</em> works from <em>whether the score works</em>. Outcomes are
        simulated once ~3 trading days of price history pass.
      </p>

      <div className="shadow-verdict">{verdict(stats)}</div>

      <div className="journal-table-wrap">
        <table className="journal-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Plans</th>
              <th>Pending</th>
              <th>Evaluated</th>
              <th>Fill rate</th>
              <th>Win rate</th>
              <th>Expectancy / plan</th>
              <th>Profit factor</th>
              <th>Net P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {stats.length === 0 ? (
              <tr>
                <td colSpan={9}>No shadow plans yet — the first batch lands after the next market close.</td>
              </tr>
            ) : (
              stats.map((s) => (
                <tr key={s.source}>
                  <td>{SOURCE_LABEL[s.source] ?? s.source}</td>
                  <td>{s.plans}</td>
                  <td>{s.pending}</td>
                  <td>{s.evaluated}</td>
                  <td>{s.evaluated ? pct(s.fillRate) : "—"}</td>
                  <td>{s.fills ? pct(s.winRate) : "—"}</td>
                  <td className={pnlClass(s.evaluated ? s.expectancy : null)}>
                    {s.evaluated ? rupiah(s.expectancy) : "—"}
                  </td>
                  <td>{s.evaluated ? (s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2)) : "—"}</td>
                  <td className={pnlClass(s.evaluated ? s.netPnl : null)}>
                    {s.evaluated ? rupiah(s.netPnl) : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <h3 className="shadow-subhead">Recent plans</h3>
      <div className="journal-table-wrap">
        <table className="journal-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Symbol</th>
              <th>Source</th>
              <th>Cat.</th>
              <th>Entry</th>
              <th>SL</th>
              <th>Lots</th>
              <th>R:R</th>
              <th>Outcome</th>
              <th>Exit</th>
              <th>Net P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 ? (
              <tr>
                <td colSpan={11}>Nothing yet.</td>
              </tr>
            ) : (
              recent.map((r, i) => (
                <tr key={`${r.tradingDate}-${r.source}-${r.symbol}-${i}`}>
                  <td>{r.tradingDate}</td>
                  <td>{r.symbol}</td>
                  <td>{r.source.replace("screener_", "").replace("baseline_", "~")}</td>
                  <td>{r.category ?? "—"}</td>
                  <td>{r.entryTrigger.toLocaleString("id-ID")}</td>
                  <td>{r.slPrice.toLocaleString("id-ID")}</td>
                  <td>{r.totalLots}</td>
                  <td>{r.netRewardToRisk.toFixed(2)}</td>
                  <td>
                    {r.outcomeStatus ? (
                      <span className="fill-status">{r.outcomeStatus}</span>
                    ) : (
                      <span className="fill-status">pending</span>
                    )}
                  </td>
                  <td>{r.firstExitReason ?? "—"}</td>
                  <td className={pnlClass(r.netPnl)}>{r.netPnl !== null ? rupiah(r.netPnl) : "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
