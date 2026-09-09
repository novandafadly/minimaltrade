/**
 * Batches incoming SSE events over a short window before flushing, so a burst
 * of `signal_update` ticks doesn't thrash React state / query cache commits.
 * Pure and timer-injectable so it's unit testable without fake DOM timers.
 */
export interface Batcher<T> {
  push(item: T): void;
  flushNow(): void;
  dispose(): void;
}

export interface BatcherOptions<T> {
  windowMs?: number;
  onFlush: (items: T[]) => void;
  /** injectable for tests; defaults to global timers */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

const DEFAULT_WINDOW_MS = 300;

export function createBatcher<T>(options: BatcherOptions<T>): Batcher<T> {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const scheduleTimeout = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancelTimeout = options.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let buffer: T[] = [];
  let handle: unknown = null;

  function flush() {
    if (handle !== null) {
      cancelTimeout(handle);
      handle = null;
    }
    if (buffer.length === 0) return;
    const items = buffer;
    buffer = [];
    options.onFlush(items);
  }

  return {
    push(item: T) {
      buffer.push(item);
      if (handle === null) {
        handle = scheduleTimeout(() => {
          handle = null;
          flush();
        }, windowMs);
      }
    },
    flushNow: flush,
    dispose() {
      if (handle !== null) {
        cancelTimeout(handle);
        handle = null;
      }
      buffer = [];
    }
  };
}

/**
 * Collapses a batch of signal_update events to the latest event per symbol,
 * preserving the order symbols were first seen — avoids redundant re-renders
 * when the same symbol ticks multiple times inside one batch window.
 */
export function dedupeBySymbol<T extends { symbol: string }>(items: T[]): T[] {
  const order: string[] = [];
  const latest = new Map<string, T>();
  for (const item of items) {
    if (!latest.has(item.symbol)) order.push(item.symbol);
    latest.set(item.symbol, item);
  }
  return order.map((symbol) => latest.get(symbol) as T);
}
