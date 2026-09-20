import { describe, it, expect } from "vitest";
import type { BrokerSummaryData, HistoryData, MarketCapEntry, OhlcvBar, ScreenerSignalRow } from "@idx/domain";
import {
  arjumShortlist,
  consensusShortlist,
  flowShortlist,
  marketcapShortlist,
  netFlowImbalance,
  technicalShortlist,
  technicalUniverse
} from "../screeners.js";

function bars(closes: number[], volume = 1_000_000): OhlcvBar[] {
  return closes.map((c, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    open: c,
    high: c * 1.01,
    low: c * 0.99,
    close: c,
    volume,
    turnover: c * volume
  }));
}

function history(symbol: string, closes: number[], volume?: number): HistoryData {
  return { symbol, bars: bars(closes, volume), baselineMedianVolume20d: null };
}

const uptrend = Array.from({ length: 60 }, (_, i) => 100 + i * 2); // strong steady climb
const downtrend = Array.from({ length: 60 }, (_, i) => 200 - i * 2);
const flat = Array.from({ length: 60 }, () => 100);

function screenerRow(symbol: string, wr: number, potential: number): ScreenerSignalRow {
  return { symbol, name: symbol, bucket: "🟢", summary: null, note: null, drawdown: null, wrEvent: wr, potential };
}

function mcapEntry(symbol: string, marketCap: number, turnoverRatio: number, close = 500): MarketCapEntry {
  return { symbol, sharesOutstanding: marketCap / close, marketCap, close, turnoverRatio };
}

describe("shadow screeners", () => {
  it("arjumShortlist ranks by wr × potential and needs history", () => {
    const rows = [screenerRow("AAA", 80, 20), screenerRow("BBB", 40, 5), screenerRow("CCC", 90, 40)];
    const h = new Map([
      ["AAA", history("AAA", uptrend)],
      ["BBB", history("BBB", uptrend)]
      // CCC has no history -> excluded despite the best edge
    ]);
    expect(arjumShortlist(rows, h)).toEqual(["AAA", "BBB"]);
  });

  it("marketcapShortlist keeps only names inside the liquidity/size band", () => {
    const rows = [screenerRow("BIG", 50, 10), screenerRow("MICRO", 50, 10), screenerRow("OK", 50, 10)];
    const h = new Map(rows.map((r) => [r.symbol, history(r.symbol, uptrend)] as const));
    const mcap = new Map([
      ["BIG", mcapEntry("BIG", 100_000_000_000_000, 0.01)], // above ceiling
      ["MICRO", mcapEntry("MICRO", 10_000_000_000, 0.01)], // below floor
      ["OK", mcapEntry("OK", 1_000_000_000_000, 0.01)]
    ]);
    expect(marketcapShortlist(rows, mcap, h)).toEqual(["OK"]);
  });

  it("technicalUniverse takes the most liquid names above the price floor", () => {
    const mcap = [
      mcapEntry("A", 1e12, 0.05, 500),
      mcapEntry("B", 1e12, 0.09, 500),
      mcapEntry("PENNY", 1e12, 0.2, 10), // below price floor
      mcapEntry("C", 1e12, 0.01, 500)
    ];
    expect(technicalUniverse(mcap)).toEqual(["B", "A", "C"]);
  });

  it("technicalShortlist picks uptrending breakouts, rejects downtrends/flats", () => {
    const bigVol = 50_000_000; // keep 20-bar avg turnover above the floor
    const h = new Map([
      ["UP", history("UP", uptrend, bigVol)],
      ["DOWN", history("DOWN", downtrend, bigVol)],
      ["FLAT", history("FLAT", flat, bigVol)]
    ]);
    const out = technicalShortlist(h, ["UP", "DOWN", "FLAT"]);
    expect(out).toContain("UP");
    expect(out).not.toContain("DOWN");
    expect(out).not.toContain("FLAT");
  });

  it("consensusShortlist returns names ≥2 lists agree on, ranked by agreement", () => {
    expect(
      consensusShortlist([
        ["A", "B", "C"],
        ["B", "C", "D"],
        ["C", "E"]
      ])
    ).toEqual(["C", "B"]);
  });

  it("netFlowImbalance = sum(net value) / sum(buy value) over the book", () => {
    const book = {
      symbol: "X",
      segment: "regular",
      totalVolume: 0,
      totalValue: 0,
      brokers: [
        { brokerCode: "A", buyVolume: 0, buyValue: 800, sellVolume: 0, sellValue: 200, netVolume: 0, netValue: 600, avgBuyPrice: null, avgSellPrice: null },
        { brokerCode: "B", buyVolume: 0, buyValue: 200, sellVolume: 0, sellValue: 800, netVolume: 0, netValue: -600, avgBuyPrice: null, avgSellPrice: null },
        { brokerCode: "C", buyVolume: 0, buyValue: 500, sellVolume: 0, sellValue: 100, netVolume: 0, netValue: 400, avgBuyPrice: null, avgSellPrice: null }
      ]
    } as unknown as BrokerSummaryData;
    expect(netFlowImbalance(book)).toBeCloseTo(400 / 1500, 6);
    expect(netFlowImbalance({ ...book, brokers: [] })).toBeNull();
  });

  it("flowShortlist keeps only positive imbalance, highest first, and needs history", () => {
    const h = new Map([
      ["A", history("A", uptrend)],
      ["B", history("B", uptrend)],
      ["C", history("C", uptrend)]
      // D has no history
    ]);
    const out = flowShortlist(
      [
        { symbol: "A", imbalance: 0.05 },
        { symbol: "B", imbalance: 0.4 },
        { symbol: "C", imbalance: -0.2 }, // net selling -> excluded
        { symbol: "D", imbalance: 0.9 }, // no history -> excluded
        { symbol: "E", imbalance: null }
      ],
      h
    );
    expect(out).toEqual(["B", "A"]);
  });
});
