"use client";

export function LoadingState({ label = "Loading signals…" }: { label?: string }) {
  return (
    <div className="state-panel state-loading" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

export function EmptyState({
  title = "No candidates right now",
  detail = "The funnel hasn't produced any watchlist or trade-plan candidates for the current session yet."
}: {
  title?: string;
  detail?: string;
}) {
  return (
    <div className="state-panel state-empty">
      <p className="state-title">{title}</p>
      <p className="state-detail">{detail}</p>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state-panel state-error" role="alert">
      <p className="state-title">Couldn&apos;t load data</p>
      <p className="state-detail">{message}</p>
      {onRetry ? (
        <button className="btn btn-secondary" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function DegradedBanner({ notes }: { notes: string[] }) {
  return (
    <div className="banner banner-degraded" role="status">
      <strong>Degraded:</strong>{" "}
      {notes.length > 0 ? notes[notes.length - 1] : "Upstream data quality is degraded; treat signals with caution."}
    </div>
  );
}

export function DownBanner({ notes }: { notes: string[] }) {
  return (
    <div className="banner banner-down" role="alert">
      <strong>System down:</strong>{" "}
      {notes.length > 0 ? notes[notes.length - 1] : "Worker/upstream appears stopped. Do not trust active signals."}
    </div>
  );
}

export function PartialDataBanner({ message }: { message: string }) {
  return (
    <div className="banner banner-partial" role="status">
      <strong>Partial data:</strong> {message}
    </div>
  );
}

export function StaleRowNotice() {
  return <span className="stale-tag" title="This row's data is stale — the plan action is disabled.">STALE</span>;
}

export function NoTradeNotice({ reason }: { reason: string | null }) {
  return (
    <div className="no-trade-notice">
      <span className="badge badge-muted">NO TRADE</span>
      <span className="state-detail">{reason ?? "No qualifying setup — this is a normal, expected output."}</span>
    </div>
  );
}
