import { describe, expect, it, vi } from "vitest";
import { createBatcher, dedupeBySymbol } from "../lib/sseBatch";

describe("createBatcher", () => {
  it("does not flush before the window elapses", () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const batcher = createBatcher<{ symbol: string }>({ windowMs: 300, onFlush });
    batcher.push({ symbol: "BBCA" });
    vi.advanceTimersByTime(299);
    expect(onFlush).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("flushes all buffered items once the window elapses", () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const batcher = createBatcher<{ symbol: string }>({ windowMs: 300, onFlush });
    batcher.push({ symbol: "BBCA" });
    batcher.push({ symbol: "TLKM" });
    vi.advanceTimersByTime(300);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith([{ symbol: "BBCA" }, { symbol: "TLKM" }]);
    vi.useRealTimers();
  });

  it("coalesces a burst into a single flush rather than one per push", () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const batcher = createBatcher<{ symbol: string }>({ windowMs: 300, onFlush });
    for (let i = 0; i < 20; i++) {
      batcher.push({ symbol: `SYM${i}` });
      vi.advanceTimersByTime(10); // bursty ticks well inside the window
    }
    vi.advanceTimersByTime(300);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0]?.[0]).toHaveLength(20);
    vi.useRealTimers();
  });

  it("flushNow flushes immediately and clears the pending timer", () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const batcher = createBatcher<{ symbol: string }>({ windowMs: 300, onFlush });
    batcher.push({ symbol: "BBCA" });
    batcher.flushNow();
    expect(onFlush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300);
    expect(onFlush).toHaveBeenCalledTimes(1); // no double-flush
    vi.useRealTimers();
  });

  it("dispose discards buffered items without flushing", () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const batcher = createBatcher<{ symbol: string }>({ windowMs: 300, onFlush });
    batcher.push({ symbol: "BBCA" });
    batcher.dispose();
    vi.advanceTimersByTime(1000);
    expect(onFlush).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("dedupeBySymbol", () => {
  it("keeps only the latest event per symbol, preserving first-seen order", () => {
    const items = [
      { symbol: "BBCA", category: "WATCHLIST" },
      { symbol: "TLKM", category: "AVOID" },
      { symbol: "BBCA", category: "STRONG_BUY" }
    ];
    expect(dedupeBySymbol(items)).toEqual([
      { symbol: "BBCA", category: "STRONG_BUY" },
      { symbol: "TLKM", category: "AVOID" }
    ]);
  });

  it("returns an empty array for an empty input", () => {
    expect(dedupeBySymbol([])).toEqual([]);
  });
});
