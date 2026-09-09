import type { DataEnvelope, HistoryData } from "@idx/domain";
import type { ReplayDataSource } from "./types.js";

/**
 * Thrown when a decision-time query returns data that could not have been
 * known at `asOf`. Catching this at test time is how we prove the no-future-
 * leakage constraint is actually enforced, not just assumed.
 */
export class FutureLeakageError extends Error {
  constructor(
    message: string,
    public readonly symbol: string,
    public readonly asOf: string
  ) {
    super(message);
    this.name = "FutureLeakageError";
  }
}

/** True if `dateOrTimestamp` (YYYY-MM-DD or ISO 8601) is strictly after `asOf` (ISO 8601). */
function isAfter(dateOrTimestamp: string, asOf: string): boolean {
  // A bare YYYY-MM-DD trading date is compared as that date's start-of-day;
  // a full ISO timestamp compares directly. Lexicographic comparison is
  // correct for both since both are zero-padded ISO-8601-family strings.
  const normalized = dateOrTimestamp.length === 10 ? `${dateOrTimestamp}T00:00:00.000Z` : dateOrTimestamp;
  return normalized > asOf;
}

function assertEnvelopeNotFromFuture(envelope: DataEnvelope<HistoryData>, symbol: string, asOf: string): void {
  if (envelope.receivedAt && isAfter(envelope.receivedAt, asOf)) {
    throw new FutureLeakageError(
      `getHistoryAsOf(${symbol}, ${asOf}) returned an envelope received at ${envelope.receivedAt}, after asOf`,
      symbol,
      asOf
    );
  }
  if (envelope.publishedAt && isAfter(envelope.publishedAt, asOf)) {
    throw new FutureLeakageError(
      `getHistoryAsOf(${symbol}, ${asOf}) returned an envelope published at ${envelope.publishedAt}, after asOf`,
      symbol,
      asOf
    );
  }
  for (const bar of envelope.data.bars) {
    if (isAfter(bar.date, asOf)) {
      throw new FutureLeakageError(
        `getHistoryAsOf(${symbol}, ${asOf}) leaked a bar dated ${bar.date}, after asOf`,
        symbol,
        asOf
      );
    }
  }
}

/**
 * Wraps any ReplayDataSource so its decision-time methods are checked
 * against the no-future-leakage constraint at call time. Wrap every data
 * source with this before using it for replay decisions -- it is cheap and
 * turns a silent lookahead bug into an immediate thrown error instead of a
 * quietly-too-good backtest.
 */
export function withLeakGuard(source: ReplayDataSource): ReplayDataSource {
  // NOTE: `source` is typically a class instance whose methods live on its
  // prototype, not as own enumerable properties -- an object spread here
  // would silently drop them. Bind every method explicitly instead.
  return {
    listTradingDates: source.listTradingDates.bind(source),
    async getHistoryAsOf(symbol, asOf) {
      const envelope = await source.getHistoryAsOf(symbol, asOf);
      if (envelope) assertEnvelopeNotFromFuture(envelope, symbol, asOf);
      return envelope;
    },
    async listUniverseAsOf(asOf) {
      // Universe entries carry no per-row receivedAt of their own in this
      // contract; the underlying implementation is responsible for deriving
      // them only from history it would return via getHistoryAsOf. Guarding
      // indirectly by cross-checking against getHistoryAsOf for every
      // returned symbol is deliberately NOT done here (would be O(n) extra
      // queries per call) -- implementations are expected to build universe
      // membership from the same asOf-filtered source, and the fixture/
      // Postgres implementations do so.
      return source.listUniverseAsOf(asOf);
    },
    getTradePlansForDate: source.getTradePlansForDate.bind(source),
    getBarOn: source.getBarOn.bind(source),
    getSimulationBars: source.getSimulationBars.bind(source)
  };
}
