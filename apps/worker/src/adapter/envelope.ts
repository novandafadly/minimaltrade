import type { DataEnvelope, DataFinality, MarketSegment } from "@idx/domain";

/**
 * Builds a DataEnvelope<T> per the blueprint §3 minimum contract: symbol,
 * event time or trading date, published_at if available, received_at,
 * source, segment, revision id, status.
 *
 * "Data tanpa timestamp tidak boleh memicu sinyal eksekusi": if none of
 * tradingDate/eventTime/publishedAt are present, the envelope is forced to
 * status "provisional" regardless of what the source declared, and callers
 * (funnel/scoring) must treat provisional data as ineligible for an active
 * signal.
 */
export function buildEnvelope<T>(params: {
  symbol: string;
  tradingDate: string | null;
  eventTime: string | null;
  publishedAt: string | null;
  receivedAt: string;
  segment: MarketSegment;
  revisionId: string | null;
  declaredStatus?: DataFinality | null | undefined;
  data: T;
}): DataEnvelope<T> {
  const hasUsableTimestamp = Boolean(params.tradingDate || params.eventTime || params.publishedAt);
  const status: DataFinality = hasUsableTimestamp ? (params.declaredStatus ?? "provisional") : "provisional";
  const tradingDate = params.tradingDate ?? isoDateOnly(params.receivedAt);

  return {
    symbol: params.symbol,
    tradingDate,
    eventTime: params.eventTime,
    publishedAt: params.publishedAt,
    receivedAt: params.receivedAt,
    source: "arjum",
    segment: params.segment,
    revisionId: params.revisionId,
    status,
    data: params.data
  };
}

export function isoDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

/** True if the envelope should NOT be allowed to drive an active signal:
 * provisional status, or a trading date far enough in the past that it's
 * stale relative to `now` (caller supplies the staleness threshold). */
export function isEnvelopeStale(
  envelope: Pick<DataEnvelope<unknown>, "status" | "tradingDate">,
  now: string,
  maxAgeDays = 1
): boolean {
  if (envelope.status === "provisional") return true;
  const ageMs = Date.parse(now) - Date.parse(`${envelope.tradingDate}T00:00:00Z`);
  if (Number.isNaN(ageMs)) return true;
  return ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
}
