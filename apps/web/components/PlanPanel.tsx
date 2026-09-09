"use client";

import type { SignalListItem } from "../lib/types";
import { formatRatio, formatRupiah } from "../lib/format";
import { useCreatePaperTrade } from "../lib/hooks";
import { NoTradeNotice } from "./StatePanels";

/**
 * Renders the plan as literal, broker-app-ready order instructions —
 * matching the blueprint's own example format: "ENTRY Rp1.000 sampai
 * Rp1.005, 14 lot. TP1 Rp1.040 jual 8 lot. TP2 Rp1.060 jual 6 lot. SL Rp980
 * jual seluruh sisa. Net RR 2,1. Setup kedaluwarsa akhir sesi. Owner
 * unverified."
 */
export function PlanPanel({ signal }: { signal: SignalListItem }) {
  const createTrade = useCreatePaperTrade();

  const isNoTrade = signal.category === "NO_TRADE" || signal.plan === null || signal.plan.isNoTrade;
  if (isNoTrade) {
    return (
      <div className="plan-panel">
        <NoTradeNotice reason={signal.noTradeReason ?? signal.plan?.noTradeReason ?? null} />
      </div>
    );
  }

  const plan = signal.plan!;
  const expiryLabel = new Date(plan.expiry).toLocaleString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "short"
  });

  const sentence = `ENTRY ${formatRupiah(plan.entryTrigger)} sampai ${formatRupiah(plan.maxBuyPrice)}, ${plan.totalLots} lot. TP1 ${formatRupiah(plan.tp1Price)} jual ${plan.tp1Lots} lot. TP2 ${formatRupiah(plan.tp2Price)} jual ${plan.tp2Lots} lot. SL ${formatRupiah(plan.slPrice)} jual seluruh sisa (${plan.slRemainingLots} lot). Net RR ${formatRatio(plan.netRewardToRisk)}. Setup kedaluwarsa ${expiryLabel}. Owner unverified.`;

  return (
    <div className="plan-panel">
      <p className="plan-sentence">{sentence}</p>

      <dl className="plan-grid">
        <div>
          <dt>Entry trigger</dt>
          <dd>{formatRupiah(plan.entryTrigger)}</dd>
        </div>
        <div>
          <dt>Max buy price</dt>
          <dd>{formatRupiah(plan.maxBuyPrice)}</dd>
        </div>
        <div>
          <dt>Total lots</dt>
          <dd>{plan.totalLots}</dd>
        </div>
        <div>
          <dt>Estimated capital</dt>
          <dd>{formatRupiah(plan.estimatedCapital)}</dd>
        </div>
        <div>
          <dt>TP1</dt>
          <dd>
            {formatRupiah(plan.tp1Price)} × {plan.tp1Lots} lot
          </dd>
        </div>
        <div>
          <dt>TP2</dt>
          <dd>
            {formatRupiah(plan.tp2Price)} × {plan.tp2Lots} lot
          </dd>
        </div>
        <div>
          <dt>Stop loss</dt>
          <dd>
            {formatRupiah(plan.slPrice)} × {plan.slRemainingLots} lot (sisa)
          </dd>
        </div>
        <div>
          <dt>Expiry</dt>
          <dd>{expiryLabel}</dd>
        </div>
        <div>
          <dt>Gross reward</dt>
          <dd>{formatRupiah(plan.grossReward)}</dd>
        </div>
        <div>
          <dt>Estimated fees</dt>
          <dd>{formatRupiah(plan.estimatedFees)}</dd>
        </div>
        <div>
          <dt>Slippage allowance</dt>
          <dd>{formatRupiah(plan.slippageAllowance)}</dd>
        </div>
        <div>
          <dt>Net reward</dt>
          <dd>{formatRupiah(plan.netReward)}</dd>
        </div>
        <div>
          <dt>Max net loss</dt>
          <dd>{formatRupiah(plan.maxNetLoss)}</dd>
        </div>
        <div>
          <dt>Net RR</dt>
          <dd>{formatRatio(plan.netRewardToRisk)}</dd>
        </div>
      </dl>

      <div className="owner-disclosure">
        Owner unverified — broker-flow evidence does not establish beneficial-owner identity or independence.
      </div>

      <button
        className="btn btn-primary"
        disabled={signal.dataStale || createTrade.isPending}
        title={signal.dataStale ? "Disabled: this signal's data is stale" : undefined}
        onClick={() =>
          createTrade.mutate({
            symbol: signal.symbol,
            plannedEntry: plan.entryTrigger
          })
        }
      >
        {signal.dataStale ? "Plan disabled (stale data)" : createTrade.isPending ? "Logging…" : "Log to journal (plan followed)"}
      </button>
      {createTrade.isSuccess ? <span className="inline-confirm">Logged.</span> : null}
      {createTrade.isError ? (
        <span className="inline-error">{createTrade.error instanceof Error ? createTrade.error.message : "Failed"}</span>
      ) : null}
    </div>
  );
}
