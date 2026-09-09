"use client";

import { Header } from "./Header";
import { SummaryStrip } from "./SummaryStrip";
import { TriggerTable } from "./TriggerTable";
import { DetailDrawer } from "./DetailDrawer";
import { JournalView } from "./JournalView";
import { LoadingState, EmptyState, ErrorState, DegradedBanner, DownBanner, PartialDataBanner } from "./StatePanels";
import { useHealth, useSignals, useSseSignalStream } from "../lib/hooks";
import { useUiStore } from "../store/uiStore";
import { emptyCategoryCounts } from "../lib/category";

export function Dashboard() {
  useSseSignalStream();

  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);

  const signalsQuery = useSignals();
  const healthQuery = useHealth();

  const partialData =
    signalsQuery.data?.signals.some((s) => s.broker === null || s.plan === null) &&
    signalsQuery.data.signals.length > 0;

  return (
    <div className="dashboard">
      <Header />

      <nav className="view-tabs">
        <button className={view === "trigger" ? "tab-active" : ""} onClick={() => setView("trigger")}>
          Trigger table
        </button>
        <button className={view === "journal" ? "tab-active" : ""} onClick={() => setView("journal")}>
          Journal
        </button>
      </nav>

      {healthQuery.data?.status === "down" ? <DownBanner notes={healthQuery.data.notes} /> : null}
      {healthQuery.data?.status === "degraded" ? <DegradedBanner notes={healthQuery.data.notes} /> : null}
      {partialData ? (
        <PartialDataBanner message="Some signals are missing broker-flow evidence or a trade plan (e.g. NO_TRADE outputs) — shown as “—”." />
      ) : null}

      {view === "trigger" ? (
        <>
          <SummaryStrip counts={signalsQuery.data?.counts ?? emptyCategoryCounts()} />
          {signalsQuery.isLoading ? (
            <LoadingState />
          ) : signalsQuery.isError ? (
            <ErrorState
              message={signalsQuery.error instanceof Error ? signalsQuery.error.message : "Failed to load signals"}
              onRetry={() => signalsQuery.refetch()}
            />
          ) : !signalsQuery.data || signalsQuery.data.signals.length === 0 ? (
            <EmptyState />
          ) : (
            <TriggerTable signals={signalsQuery.data.signals} />
          )}
        </>
      ) : (
        <JournalView />
      )}

      <DetailDrawer />
    </div>
  );
}
