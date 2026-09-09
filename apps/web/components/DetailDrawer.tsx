"use client";

import { useUiStore } from "../store/uiStore";
import { useSignalDetail } from "../lib/hooks";
import { formatAge, formatNumber, formatPercent, formatRupiah } from "../lib/format";
import { gateLabel, summarizeGates } from "../lib/gates";
import { categoryBadge } from "../lib/category";
import { toneClassName } from "./tone";
import { LoadingState, ErrorState } from "./StatePanels";
import { PlanPanel } from "./PlanPanel";

export function DetailDrawer() {
  const drawerOpen = useUiStore((s) => s.drawerOpen);
  const selectedSymbol = useUiStore((s) => s.selectedSymbol);
  const closeDrawer = useUiStore((s) => s.closeDrawer);

  const { data, isLoading, isError, error, refetch } = useSignalDetail(drawerOpen ? selectedSymbol : null);

  if (!drawerOpen) return null;

  return (
    <div className="drawer-backdrop" onClick={closeDrawer}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label={`Detail for ${selectedSymbol}`}>
        <div className="drawer-header">
          <h2>{selectedSymbol}</h2>
          <button className="btn btn-icon" onClick={closeDrawer} aria-label="Close">
            ✕
          </button>
        </div>

        {isLoading ? (
          <LoadingState label={`Loading ${selectedSymbol} detail…`} />
        ) : isError ? (
          <ErrorState message={error instanceof Error ? error.message : "Failed to load detail"} onRetry={() => refetch()} />
        ) : data ? (
          <DrawerContent data={data} />
        ) : null}
      </aside>
    </div>
  );
}

function DrawerContent({ data }: { data: NonNullable<ReturnType<typeof useSignalDetail>["data"]> }) {
  const { signal, feature, brokerMatrix, evidence } = data;
  const badge = categoryBadge(signal.category);
  const gateSummary = summarizeGates(signal.gates);

  return (
    <div className="drawer-content">
      <section className="drawer-section">
        <div className="drawer-summary-row">
          <span className={toneClassName(badge.tone)}>{badge.label}</span>
          <span>Score {signal.compositeScore.toFixed(1)}</span>
          <span>Confidence: {signal.confidence}</span>
          <span title={signal.generatedAt}>Generated {formatAge(signal.generatedAt)} ago</span>
          {signal.dataStale ? <span className="stale-tag">STALE</span> : null}
        </div>
      </section>

      <section className="drawer-section">
        <h3>Plan panel</h3>
        <PlanPanel signal={signal} />
      </section>

      <section className="drawer-section">
        <h3>Broker flow evidence</h3>
        {feature ? (
          <dl className="plan-grid">
            <div>
              <dt>B-Avg</dt>
              <dd>{formatRupiah(feature.brokerFlow.bAvg)} ({feature.brokerFlow.bAvgConfidence} confidence)</dd>
            </div>
            <div>
              <dt>Buyer breadth</dt>
              <dd>{feature.brokerFlow.buyerBreadthCount} ({feature.brokerFlow.meaningfulBuyerCount} meaningful)</dd>
            </div>
            <div>
              <dt>Top1 / Top3 share</dt>
              <dd>
                {formatPercent(feature.brokerFlow.top1Share)} / {formatPercent(feature.brokerFlow.top3Share)}
              </dd>
            </div>
            <div>
              <dt>HHI</dt>
              <dd>{feature.brokerFlow.hhi.toFixed(3)}</dd>
            </div>
            <div>
              <dt>Persistence</dt>
              <dd>
                {feature.brokerFlow.persistenceDays} / {feature.brokerFlow.persistenceWindowDays} days
              </dd>
            </div>
            <div>
              <dt>Seller concentration (Top1)</dt>
              <dd>{formatPercent(feature.brokerFlow.sellerConcentrationTop1Share)}</dd>
            </div>
            <div>
              <dt>Broker flip</dt>
              <dd>{feature.brokerFlow.brokerFlip ? "Yes" : "No"}</dd>
            </div>
            <div>
              <dt>Suspected transfer</dt>
              <dd>{feature.brokerFlow.suspectedTransfer ? "Yes" : "No"}</dd>
            </div>
            <div>
              <dt>Failed absorption</dt>
              <dd>{feature.brokerFlow.failedAbsorption ? "Yes" : "No"}</dd>
            </div>
          </dl>
        ) : (
          <p className="state-detail">No feature snapshot available for this symbol.</p>
        )}
      </section>

      <section className="drawer-section">
        <h3>Broker matrix ({brokerMatrix.length} brokers)</h3>
        {brokerMatrix.length === 0 ? (
          <p className="state-detail">No broker snapshot rows found for this trading date.</p>
        ) : (
          <div className="broker-matrix-wrap">
            <table className="broker-matrix">
              <thead>
                <tr>
                  <th>Broker</th>
                  <th>Buy vol</th>
                  <th>Sell vol</th>
                  <th>Net vol</th>
                  <th>Net value</th>
                  <th>Avg buy</th>
                  <th>Avg sell</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {brokerMatrix.map((b) => (
                  <tr key={b.brokerCode} className={b.netVolume > 0 ? "row-net-buy" : b.netVolume < 0 ? "row-net-sell" : ""}>
                    <td>{b.brokerCode}</td>
                    <td>{formatNumber(b.buyVolume)}</td>
                    <td>{formatNumber(b.sellVolume)}</td>
                    <td>{formatNumber(b.netVolume)}</td>
                    <td>{formatRupiah(b.netValue)}</td>
                    <td>{formatRupiah(b.avgBuyPrice)}</td>
                    <td>{formatRupiah(b.avgSellPrice)}</td>
                    <td>{b.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="drawer-section">
        <h3>
          Hard gates ({gateSummary.passedGates}/{gateSummary.totalGates} passed)
        </h3>
        <ul className="gate-list">
          {signal.gates.map((g) => (
            <li key={g.gate} className={g.passed ? "gate-pass" : "gate-fail"}>
              <span className="gate-status">{g.passed ? "PASS" : "FAIL"}</span>
              <span className="gate-name">{gateLabel(g.gate)}</span>
              {g.reason ? <span className="gate-reason">{g.reason}</span> : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="drawer-section">
        <h3>Audit / raw evidence</h3>
        <dl className="plan-grid">
          <div>
            <dt>Input snapshot id</dt>
            <dd className="mono">{evidence.inputSnapshotId}</dd>
          </div>
          <div>
            <dt>Formula version</dt>
            <dd className="mono">{evidence.formulaVersion}</dd>
          </div>
          <div>
            <dt>Config version</dt>
            <dd className="mono">{evidence.configVersion}</dd>
          </div>
          <div>
            <dt>Raw payload archive</dt>
            <dd className="mono">{evidence.rawPayloadArchiveHint}</dd>
          </div>
        </dl>
        <p className="owner-disclosure">
          Owner unverified — broker codes identify securities firms executing the order, not beneficial owners.
          Nothing here establishes independence between accounts.
        </p>
      </section>
    </div>
  );
}
