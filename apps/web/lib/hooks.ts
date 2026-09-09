"use client";

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import type {
  HealthResponse,
  PaperTradeView,
  SignalDetailResponse,
  SignalListResponse,
  SseEnvelope
} from "./types";
import { createBatcher, dedupeBySymbol } from "./sseBatch";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message ?? body?.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function useSignals() {
  return useQuery({
    queryKey: ["signals"],
    queryFn: () => fetchJson<SignalListResponse>("/api/signals")
  });
}

export function useSignalDetail(symbol: string | null) {
  return useQuery({
    queryKey: ["signal", symbol],
    queryFn: () => fetchJson<SignalDetailResponse>(`/api/signals/${symbol}`),
    enabled: Boolean(symbol)
  });
}

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => fetchJson<HealthResponse>("/api/health"),
    refetchInterval: 20_000
  });
}

export function useJournal(symbol?: string) {
  return useQuery({
    queryKey: ["journal", symbol ?? "all"],
    queryFn: () => fetchJson<{ trades: PaperTradeView[] }>(symbol ? `/api/journal?symbol=${symbol}` : "/api/journal")
  });
}

export function useCreatePaperTrade() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { symbol: string; tradePlanId?: string | null; plannedEntry: number; overrideReason?: string | null }) => {
      const res = await fetch("/api/journal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input)
      });
      if (!res.ok) throw new Error(`Failed to create paper trade: ${res.status}`);
      return res.json() as Promise<{ trade: PaperTradeView }>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journal"] });
    }
  });
}

export function useUpdatePaperTrade() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }: { id: string } & Record<string, unknown>) => {
      const res = await fetch(`/api/journal/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      });
      if (!res.ok) throw new Error(`Failed to update paper trade: ${res.status}`);
      return res.json() as Promise<{ trade: PaperTradeView }>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journal"] });
    }
  });
}

/**
 * Subscribes to /api/sse and batches incoming events over a short window
 * (see lib/sseBatch.ts) before committing to the query cache — so a burst of
 * ticks invalidates ["signals"] at most once per window instead of once per
 * event. Reconnects on error with backoff; the connection itself is a live
 * nice-to-have layered on top of TanStack Query's background refetch, which
 * keeps the dashboard correct even if this never connects.
 */
export function useSseSignalStream(options?: { windowMs?: number }) {
  const qc = useQueryClient();
  const statusRef = useRef<"connecting" | "open" | "closed">("connecting");

  useEffect(() => {
    let es: EventSource | null = null;
    let disposed = false;
    let retryDelay = 1000;
    let retryHandle: ReturnType<typeof setTimeout> | null = null;

    const batcher = createBatcher<{ symbol: string; category?: string }>({
      windowMs: options?.windowMs ?? 300,
      onFlush: (items) => {
        const deduped = dedupeBySymbol(items);
        if (deduped.length === 0) return;
        // A batched, single invalidation for the whole window — cheap even
        // for many ticks, and TanStack Query coalesces the resulting refetch.
        qc.invalidateQueries({ queryKey: ["signals"] });
        for (const item of deduped) {
          qc.invalidateQueries({ queryKey: ["signal", item.symbol] });
        }
      }
    });

    function connect() {
      if (disposed) return;
      statusRef.current = "connecting";
      es = new EventSource("/api/sse");

      es.addEventListener("open", () => {
        statusRef.current = "open";
        retryDelay = 1000;
      });

      es.addEventListener("signal_update", (evt) => {
        try {
          const payload = JSON.parse((evt as MessageEvent).data) as { symbol: string; category?: string };
          batcher.push(payload);
        } catch {
          // ignore malformed frame
        }
      });

      es.addEventListener("health_update", () => {
        qc.invalidateQueries({ queryKey: ["health"] });
      });

      es.onerror = () => {
        statusRef.current = "closed";
        es?.close();
        if (disposed) return;
        retryHandle = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      };
    }

    connect();

    return () => {
      disposed = true;
      batcher.dispose();
      if (retryHandle) clearTimeout(retryHandle);
      es?.close();
    };
  }, [qc, options?.windowMs]);
}

export type { SseEnvelope };
