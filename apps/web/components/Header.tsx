"use client";

import { useHealth } from "../lib/hooks";
import { formatAge, formatNumber } from "../lib/format";
import { healthToneClassName } from "./tone";
import { LoadingState } from "./StatePanels";

export function Header() {
  const { data, isLoading, isError, error, dataUpdatedAt } = useHealth();

  return (
    <header className="app-header">
      <div className="app-header-title">
        <h1>IDX Smart Money Decision Engine</h1>
        <span className="app-header-subtitle">Owner unverified — evidence-based, not certainty</span>
      </div>

      <div className="app-header-status">
        {isLoading ? (
          <LoadingState label="Checking health…" />
        ) : isError ? (
          <span className={`health-pill ${healthToneClassName("unknown")}`}>
            health unknown — {error instanceof Error ? error.message : "check failed"}
          </span>
        ) : data ? (
          <>
            <span className={`health-pill ${healthToneClassName(data.status)}`}>{data.status.toUpperCase()}</span>
            <span className="header-stat">
              <span className="header-stat-label">Market</span>
              <span className="header-stat-value">{data.marketOpen ? "OPEN" : "CLOSED"} · {data.sessionLabel}</span>
            </span>
            <span className="header-stat">
              <span className="header-stat-label">API budget</span>
              <span className="header-stat-value">
                {formatNumber(data.apiBudget.used)} / {formatNumber(data.apiBudget.total)}
                {data.apiBudget.total - data.apiBudget.used <= data.apiBudget.reserve ? " (reserve)" : ""}
              </span>
            </span>
            <span className="header-stat">
              <span className="header-stat-label">Data age</span>
              <span className="header-stat-value">
                {formatAge(data.worker.lastMarketSnapshotAt, Date.now())}
                {data.worker.source === "derived_fallback" ? " (derived)" : ""}
              </span>
            </span>
            <span className="header-stat">
              <span className="header-stat-label">Checked</span>
              <span className="header-stat-value">{formatAge(new Date(dataUpdatedAt).toISOString())} ago</span>
            </span>
          </>
        ) : null}
      </div>
    </header>
  );
}
