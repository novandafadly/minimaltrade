"use client";

import { useShadow } from "../lib/hooks";
import { LoadingState, ErrorState } from "./StatePanels";
import type { ShadowSourceStats } from "../lib/types";

const SOURCE_LABEL: Record<string, string> = {
  live: "Live (broker-flow score)",
  baseline_volume: "Baseline — volume rank",
  baseline_random: "Baseline — random"
};

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

function verdict(stats: ShadowSourceStats[]): string {
  const live = stats.find((s) => s.source === "live");
  const bv = stats.find((s) => s.source === "baseline_volume");
  const br = stats.find((s) => s.source === "baseline_random");
  if (!live || live.evaluated < 20) {
    return `Not enough data yet — need ~20+ evaluated live plans (have ${live?.evaluated ?? 0}). Keep it running for a few weeks.`;
  }
  const beatsBoth = (b?: ShadowSourceStats) =>
    b && live.expectancy > b.expectancy && live.profitFactor > b.profitFactor;
  if (beatsBoth(bv) && beatsBoth(br)) {
    return "Live beats BOTH baselines on expectancy AND profit factor — the broker-flow score is adding value.";
  }
  const worseThanEither =
    (bv && live.expectancy < bv.expectancy) || (br && live.expectancy < br.expectancy);
  if (worseThanEither) {
    return "Live is WORSE than a baseline — the composite score may be hurting, not helping. Consider dropping / reweighting it.";
  }
  return "Live roughly matches the baselines — the screener + liquidity filter is doing the work; the composite score is not (yet) proven to add value.";
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

  const stats = q.data?.stats ?? [];
  const recent = q.data?.recent ?? [];

  return (
    <div className="shadow-view">
      <p className="shadow-intro">
        Every EOD the engine records three plans over the same candidate pool: the real{" "}
        <strong>live</strong> broker-flow signal, plus <strong>volume-rank</strong> and{" "}
        <strong>random</strong> baselines. Once ~3 trading days of price history pass, each plan&apos;s
        outcome is simulated. If the score is worth its complexity, <strong>live</strong> should beat
        both baselines on expectancy and profit factor.
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
                  <td>{r.source.replace("baseline_", "").replace("live", "live")}</td>
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
