import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "../../../lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/fundamentals — a DESCRIPTIVE fundamental screener over the IDX universe.
 *
 * IMPORTANT — this is a categorization tool, not a trading signal. Phase 0I
 * (docs/BACKTEST_PHASE0I.md) tested profitability, value and size factors on this
 * exact dataset and found NO factor that predicts IDX returns with usable strength:
 * BP (book-to-price) was the only one with a consistently positive sign, and even
 * that was weak (t ~ 1.4-2.1, ~0 mean quintile spread once liquidity survivorship
 * is corrected for). These categories describe what kind of company a stock IS —
 * they are not a claim that any category will outperform.
 *
 * Data:
 *  - Quarterly income/balance/cash-flow statements, archived by backfillFundamentals.ts
 *    (raw_payload_archive, ARJUM). TTM figures, usable only PUBLICATION_LAG_DAYS after
 *    quarter end (no look-ahead).
 *  - Sector/industry/PE/growth/analyst fields from Yahoo Finance (raw_payload_archive,
 *    endpoint /ext/yfinance, ingestYfinance.ts) — an unofficial free source used only
 *    for descriptive fields ARJUM doesn't provide; not re-verified for predictive value.
 *  - Price/turnover from daily_bar (liquidity filter + 20-day return).
 *
 * Categories (cross-sectional, relative to today's universe — a plain ">0" cutoff
 * would pass almost everyone, the same bug fixed in watchlist.ts's FLOW flag):
 *  - growth:       REVENUE growth (top line) in the top third AND positive, AND net income
 *                  also growing — see REVENUE GROWTH below for why NI alone was dropped
 *                  as the primary signal
 *  - value:        BP (book/price) in the top third AND profitable (EP > 0) — cheap
 *                  AND earning money, not just cheap because something is broken
 *  - quality:      hygiene only — TTM net income > 0, TTM operating cash flow > 0, ROE > 0,
 *                  AND (non-bank only) debt-to-equity not excessive (see LEVERAGE below)
 *  - hidden_gem:   quality AND value AND below-median market cap AND below-median
 *                  20-day return — fundamentally fine, cheap, small, hasn't rallied yet
 *  - caution:      the mirror image — top-decile 20-day return WITHOUT NIyoy or quality
 *                  support (priced up without earnings behind it)
 *  - best_overall: NOT another independent flag — a single COMPOSITE rank (mean
 *                  percentile of ROE, BP, EP, NIyoy) among quality-passing names only,
 *                  sorted best-first and capped to BEST_OVERALL_MAX names. "Best of the
 *                  best": scores well across value, quality AND growth AT ONCE, not just
 *                  one of them. Requires every one of those four metrics present (no
 *                  partial-data names) so a name can't rank highly on one strong number
 *                  while the rest are simply unknown.
 *
 * LEVERAGE (DER). ROE alone can be misleading: a thin equity base inflates it without the
 * company being more productive (this dataset's own UNVR showed ROE 130% — a leverage/
 * buyback artifact, not organic profitability). der = (assets - equity) / equity, derived
 * from the balance-sheet identity (assets = liabilities + equity) using the SAME equity
 * figure as BP/EP/ROE (equity attributable to the parent, excluding NCI — so `der` slightly
 * overstates leverage for names with material non-controlling interests; disclosed, not
 * fixed, to stay consistent with the rest of this route's methodology). The quality gate
 * rejects der > DER_MAX_NONBANK for non-banks; banks are structurally leveraged by the
 * nature of the business (deposits are liabilities) so the DER gate does not apply to them.
 *
 * BANK VS NON-BANK. Banks' financial-statement layout differs completely (see
 * `liabilitas_dana_syirkah_temporer_dan_ekuitas` below) and their ROE/BP/EP/NIyoy are not
 * comparable to industrials/consumer/etc — mixing them in one percentile ranking unfairly
 * penalizes or flatters one group (this is exactly why Phase 0I reports "all" and
 * "non-bank" separately). ROE/BP/EP/NIyoy/RevYoy percentiles here are computed within each
 * name's OWN peer group (bank vs non-bank), not the whole universe.
 *
 * REVENUE GROWTH (RevYoy) AND MARGIN TREND. Net income alone is noisy — a one-off gain (FX,
 * asset sale) or a one-off loss can swing NIyoy without the underlying business actually
 * accelerating or decelerating. `revYoy` (revenue this quarter vs the same quarter a year
 * ago, from `penjualan_dan_pendapatan_usaha`) is a steadier growth signal and is now what
 * `growth` primarily keys on; NIyoy is kept as a confirming check (profit should follow
 * revenue, not diverge from it). `marginTrendPP` (gross margin this quarter minus gross
 * margin the same quarter a year ago, in percentage points, from revenue and
 * `beban_pokok_penjualan_dan_pendapatan`) is exposed for context but does NOT gate any
 * category — unlike DER's cap, there is no defensible threshold for "how much margin
 * compression is too much" without testing it, so this stays informational rather than
 * another unvalidated cutoff. Both fields are ARJUM-only for non-banks: banks don't report
 * a single revenue/COGS line in this format, so `revYoy`/`marginTrendPP` are null for banks
 * (consistent with DER not applying to banks either) and bank names cannot qualify for
 * `growth`.
 */

const PUBLICATION_LAG_DAYS = 90;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowsOf(res: any): any[] {
  return Array.isArray(res) ? res : (res?.rows ?? []);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function path(o: any, p: string): number | null {
  let cur = o;
  for (const k of p.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return null;
    cur = cur[k];
  }
  const n = typeof cur === "number" ? cur : typeof cur === "string" ? Number(cur) : NaN;
  return Number.isFinite(n) ? n : null;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function firstPath(o: any, ps: string[]): number | null {
  for (const p of ps) {
    const v = path(o, p);
    if (v !== null) return v;
  }
  return null;
}
const qKey = (year: number, quarter: number) => year * 4 + (quarter - 1);
function qEndDate(year: number, quarter: number): Date {
  return new Date(Date.UTC(year, quarter * 3, 0));
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/**
 * Yahoo Finance's `info` endpoint occasionally returns garbage for thinly-traded or
 * newly-listed IDX names — e.g. AADI showed forwardPE 92715 and priceToBook 26051 in
 * this pull (a near-zero denominator, not a real valuation). Clip to a plausible IDX
 * range instead of displaying nonsense; out-of-range becomes "n/a", same as missing data.
 */
function sane(n: number | null, min: number, max: number): number | null {
  return n !== null && Number.isFinite(n) && n > min && n <= max ? n : null;
}
function percentileRank(sorted: number[], v: number): number {
  // fraction of `sorted` (ascending) that is <= v
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= v) lo = mid + 1;
    else hi = mid;
  }
  return sorted.length ? lo / sorted.length : NaN;
}

/** Peer group: banks and non-banks have structurally different ROE/BP/EP/NIyoy (see
 * BANK VS NON-BANK in the module docstring), so each is ranked against its own group. */
interface PeerSorted {
  bank: number[];
  nonBank: number[];
}
function peerPercentile(peer: PeerSorted, isBank: boolean, v: number | null): number {
  return v === null ? NaN : percentileRank(isBank ? peer.bank : peer.nonBank, v);
}

interface Q {
  ni?: number;
  assets?: number;
  equity?: number;
  ocf?: number;
  /** `penjualan_dan_pendapatan_usaha` — non-bank only, see REVENUE GROWTH in the module docstring. */
  rev?: number;
  /** `beban_pokok_penjualan_dan_pendapatan` (already negative) — non-bank only. */
  cogs?: number;
}

interface Row {
  symbol: string;
  close: number;
  priceAsOf: string;
  ret20: number | null;
  avgTurnover: number;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  trailingPE: number | null;
  forwardPE: number | null;
  priceToBook: number | null;
  dividendYield: number | null;
  beta: number | null;
  recommendationKey: string | null;
  targetMeanPrice: number | null;
  niTtm: number | null;
  ocfTtm: number | null;
  equity: number | null;
  isBank: boolean;
  /** (assets - equity) / equity, derived from the balance-sheet identity. null if assets
   * or equity is unavailable, or not meaningful (assets <= equity). See module docstring. */
  der: number | null;
  roe: number | null;
  niYoy: number | null;
  /** revenue growth YoY (this quarter vs same quarter a year ago). null for banks. */
  revYoy: number | null;
  /** gross margin this quarter minus gross margin the same quarter a year ago, in
   * percentage points (e.g. 0.023 = +2.3pp). Informational only — see module docstring
   * for why it doesn't gate a category. null for banks. */
  marginTrendPP: number | null;
  bp: number | null;
  ep: number | null;
  quality: boolean | null;
  /** mean percentile rank of ROE, BP, EP, NIyoy — null unless all four are present. See
   * best_overall in the module docstring. Not itself a category flag. */
  compositeScore: number | null;
  flags: string[];
}

const BEST_OVERALL_MAX = 15;
// Debt-to-equity cap for the quality gate (non-bank only) — 2.0 (200%) is a generous
// upper bound for IDX non-financials; above it, leverage is doing more of the work than
// the business. Not applied to banks (leverage is structural to the business model).
const DER_MAX_NONBANK = 2.0;

export async function GET() {
  try {
    const db = getDb();
    const asOfDate = new Date();

    const bars = rowsOf(
      await db.execute(sql`
        select symbol, trading_date, close, volume, coalesce(turnover, close * volume) as turnover
        from daily_bar order by symbol, trading_date`)
    );
    const bySym = new Map<string, { date: string; close: number; turnover: number }[]>();
    for (const r of bars) {
      const a = bySym.get(String(r.symbol)) ?? [];
      a.push({ date: String(r.trading_date), close: Number(r.close), turnover: Number(r.turnover) });
      bySym.set(String(r.symbol), a);
    }
    const asOf = [...bySym.values()].map((b) => b[b.length - 1]?.date).filter(Boolean).sort().pop() as
      | string
      | undefined;

    const yf = rowsOf(
      await db.execute(sql`
        select distinct on (symbol) symbol, payload from raw_payload_archive
        where http_status = 200 and endpoint = '/ext/yfinance' order by symbol, received_at desc`)
    );
    const yfBySym = new Map<string, Record<string, unknown>>();
    for (const r of yf) yfBySym.set(String(r.symbol), r.payload);

    const st = rowsOf(
      await db.execute(sql`
        select distinct on (endpoint, symbol) endpoint, symbol, payload from raw_payload_archive
        where http_status = 200 and endpoint like '/api/financial-statements/%report_type%'
        order by endpoint, symbol, received_at desc`)
    );
    const ni = new Map<string, Map<number, Q>>();
    const isBankSym = new Set<string>();
    for (const r of st) {
      const sym = String(r.symbol);
      const isIncome = String(r.endpoint).includes("INCOME_STATEMENT");
      const isBalance = String(r.endpoint).includes("BALANCE_SHEET");
      const isCash = String(r.endpoint).includes("CASH_FLOW");
      const m = ni.get(sym) ?? new Map<number, Q>();
      ni.set(sym, m);
      for (const it of r.payload?.items ?? []) {
        const year = Number(it.year);
        const quarter = Number(it.quarter);
        if (!Number.isFinite(year) || !Number.isFinite(quarter)) continue;
        const q = m.get(qKey(year, quarter)) ?? {};
        const d = it.data;
        if (isIncome) {
          const v = firstPath(d, [
            "laba_rugi_yang_dapat_diatribusikan.laba_rugi_yang_dapat_diatribusikan_ke_entitas_induk",
            "laba_rugi"
          ]);
          if (v !== null) q.ni = v;
          // Non-bank only (verified across TLKM/ANTM/ICBP/ASII); absent for banks, which
          // report interest/fee income under a different structure entirely.
          const rv = path(d, "penjualan_dan_pendapatan_usaha");
          if (rv !== null) q.rev = rv;
          const cg = path(d, "beban_pokok_penjualan_dan_pendapatan");
          if (cg !== null) q.cogs = cg;
        } else if (isBalance) {
          // Banks report under `liabilitas_dana_syirkah_temporer_dan_ekuitas` (a sharia
          // banking disclosure requirement), not `liabilitas_dan_ekuitas` — that alone
          // distinguishes the layout, matching phase0i.ts's isBank detection.
          if (d && typeof d === "object" && "liabilitas_dana_syirkah_temporer_dan_ekuitas" in d) isBankSym.add(sym);
          const a = path(d, "aset.total");
          if (a !== null) q.assets = a;
          const e = firstPath(d, [
            "liabilitas_dan_ekuitas.ekuitas.ekuitas_yang_diatribusikan_kepada_pemilik_entitas_induk.total",
            "liabilitas_dan_ekuitas.ekuitas.total",
            "liabilitas_dana_syirkah_temporer_dan_ekuitas.ekuitas.ekuitas_yang_diatribusikan_kepada_pemilik_entitas_induk.total",
            "liabilitas_dana_syirkah_temporer_dan_ekuitas.ekuitas.total"
          ]);
          if (e !== null) q.equity = e;
        } else if (isCash) {
          const o = path(d, "arus_kas_dari_aktivitas_operasi.total");
          if (o !== null) q.ocf = o;
        }
        m.set(qKey(year, quarter), q);
      }
    }
    const ttmOf = (m: Map<number, Q> | undefined, field: "ni" | "ocf"): number | null => {
      if (!m) return null;
      let L = -1;
      for (const k of m.keys()) {
        const year = Math.floor(k / 4);
        const quarter = (k % 4) + 1;
        if (qEndDate(year, quarter).getTime() + PUBLICATION_LAG_DAYS * 86400000 <= asOfDate.getTime() && k > L) L = k;
      }
      if (L < 0) return null;
      const parts = [0, 1, 2, 3].map((i) => m.get(L - i)?.[field]);
      return parts.every((x) => x !== undefined) ? (parts as number[]).reduce((a, b) => a + b, 0) : null;
    };
    const latestEquity = (m: Map<number, Q> | undefined): number | null => {
      if (!m) return null;
      let L = -1;
      for (const k of m.keys()) {
        const year = Math.floor(k / 4);
        const quarter = (k % 4) + 1;
        if (qEndDate(year, quarter).getTime() + PUBLICATION_LAG_DAYS * 86400000 <= asOfDate.getTime() && k > L) L = k;
      }
      return L < 0 ? null : (m.get(L)?.equity ?? null);
    };
    const latestAssets = (m: Map<number, Q> | undefined): number | null => {
      if (!m) return null;
      let L = -1;
      for (const k of m.keys()) {
        const year = Math.floor(k / 4);
        const quarter = (k % 4) + 1;
        if (qEndDate(year, quarter).getTime() + PUBLICATION_LAG_DAYS * 86400000 <= asOfDate.getTime() && k > L) L = k;
      }
      return L < 0 ? null : (m.get(L)?.assets ?? null);
    };
    const niYoyOf = (m: Map<number, Q> | undefined): number | null => {
      if (!m) return null;
      let L = -1;
      for (const k of m.keys()) {
        const year = Math.floor(k / 4);
        const quarter = (k % 4) + 1;
        if (qEndDate(year, quarter).getTime() + PUBLICATION_LAG_DAYS * 86400000 <= asOfDate.getTime() && k > L) L = k;
      }
      if (L < 0) return null;
      const cur = m.get(L)?.ni;
      const base = m.get(L - 4)?.ni;
      if (cur === undefined || base === undefined || base === 0) return null;
      return Math.max(-3, Math.min(3, (cur - base) / Math.abs(base)));
    };
    /** Latest available quarter's index, publication-lag-aware — shared by revYoyOf/marginTrendOf
     * so both compare the SAME quarter pair (this quarter vs the same quarter a year ago). */
    const latestQuarterKey = (m: Map<number, Q> | undefined): number => {
      if (!m) return -1;
      let L = -1;
      for (const k of m.keys()) {
        const year = Math.floor(k / 4);
        const quarter = (k % 4) + 1;
        if (qEndDate(year, quarter).getTime() + PUBLICATION_LAG_DAYS * 86400000 <= asOfDate.getTime() && k > L) L = k;
      }
      return L;
    };
    const revYoyOf = (m: Map<number, Q> | undefined): number | null => {
      const L = latestQuarterKey(m);
      if (L < 0) return null;
      const cur = m!.get(L)?.rev;
      const base = m!.get(L - 4)?.rev;
      if (cur === undefined || base === undefined || base === 0) return null;
      return Math.max(-3, Math.min(3, (cur - base) / Math.abs(base)));
    };
    const grossMargin = (q: Q | undefined): number | null => {
      if (!q || q.rev === undefined || q.cogs === undefined || q.rev === 0) return null;
      return (q.rev + q.cogs) / q.rev; // cogs is already negative
    };
    const marginTrendOf = (m: Map<number, Q> | undefined): number | null => {
      const L = latestQuarterKey(m);
      if (L < 0) return null;
      const cur = grossMargin(m!.get(L));
      const base = grossMargin(m!.get(L - 4));
      return cur === null || base === null ? null : cur - base;
    };

    // Per-symbol freshness: the live worker only fills daily_bar every session for the
    // handful of names that reach the deep funnel that day (see funnel/deep.ts) — most of
    // the universe is updated in periodic bulk backfills instead, so requiring every row
    // to match the single latest global date would drop ~95% of the universe (confirmed:
    // 2026-09-22 only 8/199 symbols, 2026-09-18 152/199). Use each symbol's own latest bar,
    // capped at MAX_PRICE_AGE_DAYS old — fundamentals change quarterly so a price that is a
    // week or two stale doesn't invalidate the categorization, but a dead/delisted symbol
    // frozen for months should not appear as if it were current.
    const MAX_PRICE_AGE_DAYS = 10;
    const rows: Row[] = [];
    for (const [symbol, b] of bySym) {
      if (b.length < 25) continue;
      const i = b.length - 1;
      const lastDate = b[i]!.date;
      const ageMs = asOfDate.getTime() - Date.parse(`${lastDate}T00:00:00Z`);
      if (!(ageMs >= 0) || ageMs > MAX_PRICE_AGE_DAYS * 86400000) continue;
      const close = b[i]!.close;
      if (close < 51) continue;
      const avgTurnover = mean(b.slice(i - 19, i + 1).map((x) => x.turnover));
      if (!(avgTurnover >= 1_000_000_000)) continue;
      const ret20 = b[i - 20] ? close / b[i - 20]!.close - 1 : null;

      const yfRow = yfBySym.get(symbol) ?? {};
      const m = ni.get(symbol);
      const isBank = isBankSym.has(symbol);
      const niTtm = ttmOf(m, "ni");
      const ocfTtm = ttmOf(m, "ocf");
      const equity = latestEquity(m);
      const assets = latestAssets(m);
      const der = assets !== null && equity !== null && equity > 0 && assets > equity ? (assets - equity) / equity : null;
      const roe = niTtm !== null && equity && equity > 0 ? niTtm / equity : null;
      const niYoy = niYoyOf(m);
      const revYoy = revYoyOf(m);
      const marginTrendPP = marginTrendOf(m);
      const marketCap = typeof yfRow.marketCap === "number" ? yfRow.marketCap : null;
      const bp = equity && equity > 0 && marketCap && marketCap > 0 ? equity / marketCap : null;
      const ep = niTtm !== null && marketCap && marketCap > 0 ? niTtm / marketCap : null;
      // Quality hygiene: profitable + cash-generative + positive ROE, and (non-bank only)
      // not excessively leveraged — see LEVERAGE in the module docstring.
      const leverageOk = isBank || der === null || der <= DER_MAX_NONBANK;
      const quality =
        niTtm === null || ocfTtm === null || roe === null ? null : niTtm > 0 && ocfTtm > 0 && roe > 0 && leverageOk;

      rows.push({
        symbol,
        close,
        priceAsOf: lastDate,
        ret20,
        avgTurnover,
        sector: (yfRow.sector as string) ?? null,
        industry: (yfRow.industry as string) ?? null,
        marketCap,
        // trailing/forward PE and P/B: Yahoo's `info` returns nonsense for a handful of
        // thinly-traded names (see `sane()` above) — clip to a plausible IDX range.
        trailingPE: sane(typeof yfRow.trailingPE === "number" ? yfRow.trailingPE : null, 0, 200),
        forwardPE: sane(typeof yfRow.forwardPE === "number" ? yfRow.forwardPE : null, 0, 200),
        priceToBook: sane(typeof yfRow.priceToBook === "number" ? yfRow.priceToBook : null, 0, 50),
        // Yahoo returns dividendYield already as a percentage (6.12 means 6.12%, not
        // 612%) for this dataset — divide by 100 so it's a fraction like every other
        // ratio here, and the frontend's shared pct() helper (which does *100) is correct.
        dividendYield: sane(typeof yfRow.dividendYield === "number" ? yfRow.dividendYield / 100 : null, 0, 0.3),
        beta: typeof yfRow.beta === "number" ? yfRow.beta : null,
        recommendationKey: (yfRow.recommendationKey as string) ?? null,
        targetMeanPrice: typeof yfRow.targetMeanPrice === "number" ? yfRow.targetMeanPrice : null,
        niTtm,
        ocfTtm,
        equity,
        isBank,
        der,
        roe,
        niYoy,
        revYoy,
        marginTrendPP,
        bp,
        ep,
        quality,
        compositeScore: null,
        flags: []
      });
    }

    // cross-sectional percentile cutoffs (relative, not absolute >0 — see module docstring).
    // ROE/BP/EP/NIyoy are peer-scoped (bank vs non-bank, see BANK VS NON-BANK above); price
    // return and size are not accounting-structure-dependent, so those stay universe-wide.
    const splitSorted = (pick: (r: Row) => number | null): PeerSorted => ({
      bank: rows.filter((r) => r.isBank).map(pick).filter((v): v is number => v !== null).sort((a, b) => a - b),
      nonBank: rows.filter((r) => !r.isBank).map(pick).filter((v): v is number => v !== null).sort((a, b) => a - b)
    });
    const niYoyPeer = splitSorted((r) => r.niYoy);
    const revYoyPeer = splitSorted((r) => r.revYoy);
    const bpPeer = splitSorted((r) => r.bp);
    const epPeer = splitSorted((r) => r.ep);
    const roePeer = splitSorted((r) => r.roe);
    const mcapSorted = rows.map((r) => r.marketCap).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const ret20Sorted = rows.map((r) => r.ret20).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const medianMcap = mcapSorted.length ? mcapSorted[Math.floor(mcapSorted.length / 2)]! : NaN;
    const medianRet20 = ret20Sorted.length ? ret20Sorted[Math.floor(ret20Sorted.length / 2)]! : NaN;

    const growth: string[] = [];
    const value: string[] = [];
    const quality: string[] = [];
    const hiddenGem: string[] = [];
    const caution: string[] = [];
    const bestOverallCandidates: { symbol: string; score: number }[] = [];

    for (const r of rows) {
      const niYoyPct = peerPercentile(niYoyPeer, r.isBank, r.niYoy);
      const revYoyPct = peerPercentile(revYoyPeer, r.isBank, r.revYoy);
      const bpPct = peerPercentile(bpPeer, r.isBank, r.bp);
      const epPct = peerPercentile(epPeer, r.isBank, r.ep);
      const roePct = peerPercentile(roePeer, r.isBank, r.roe);
      const ret20Pct = r.ret20 !== null ? percentileRank(ret20Sorted, r.ret20) : NaN;

      // Revenue growth (top line) is now the primary growth signal — steadier than NI
      // alone, which a one-off gain/loss can swing (see REVENUE GROWTH in the module
      // docstring). NI growth is kept as a confirming check: profit should follow revenue.
      // Bank names have no revYoy (ARJUM doesn't expose a single revenue line for banks in
      // this format) so they cannot qualify for growth, consistent with DER's bank exemption.
      const isGrowth = r.revYoy !== null && r.revYoy > 0 && revYoyPct >= 2 / 3 && r.niYoy !== null && r.niYoy > 0;
      const isValue = r.bp !== null && bpPct >= 2 / 3 && r.ep !== null && r.ep > 0;
      const isQuality = r.quality === true;
      const isSmall = r.marketCap !== null && Number.isFinite(medianMcap) && r.marketCap <= medianMcap;
      const notYetRallied = r.ret20 !== null && Number.isFinite(medianRet20) && r.ret20 <= medianRet20;
      const isHiddenGem = isQuality && isValue && isSmall && notYetRallied;
      const isCaution = r.ret20 !== null && ret20Pct >= 0.9 && (r.niYoy === null || r.niYoy <= 0 || r.quality === false);

      if (isGrowth) {
        r.flags.push("growth");
        growth.push(r.symbol);
      }
      if (isValue) {
        r.flags.push("value");
        value.push(r.symbol);
      }
      if (isQuality) {
        r.flags.push("quality");
        quality.push(r.symbol);
      }
      if (isHiddenGem) {
        r.flags.push("hidden_gem");
        hiddenGem.push(r.symbol);
      }
      if (isCaution) {
        r.flags.push("caution");
        caution.push(r.symbol);
      }

      // best_overall: requires ALL FOUR components present (a name can't rank on one
      // strong number while the rest are unknown) AND the quality hygiene gate, then
      // ranks by the mean percentile across value (BP, EP), quality (ROE) and growth
      // (NIyoy) at once.
      if (r.quality === true && r.roe !== null && r.bp !== null && r.ep !== null && r.niYoy !== null) {
        const score = (roePct + bpPct + epPct + niYoyPct) / 4;
        r.compositeScore = Number((score * 100).toFixed(1));
        bestOverallCandidates.push({ symbol: r.symbol, score });
      }
    }

    bestOverallCandidates.sort((a, b) => b.score - a.score);
    const bestOverall = bestOverallCandidates.slice(0, BEST_OVERALL_MAX).map((c) => c.symbol);
    const bySymbol = Object.fromEntries(rows.map((r) => [r.symbol, r]));
    for (const s of bestOverall) bySymbol[s]?.flags.push("best_overall");

    return NextResponse.json({
      asOf: asOf ?? null,
      universe: rows.length,
      coverage: {
        yfinance: rows.filter((r) => r.marketCap !== null).length,
        fundamentals: rows.filter((r) => r.quality !== null).length
      },
      categories: {
        best_overall: bestOverall, // already ranked best-first — do NOT alphabetize
        growth: growth.sort(),
        value: value.sort(),
        quality: quality.sort(),
        hidden_gem: hiddenGem.sort(),
        caution: caution.sort()
      },
      rows: bySymbol,
      generatedAt: new Date().toISOString()
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "fundamentals_query_failed",
        message: err instanceof Error ? err.message : "unknown error",
        universe: 0,
        categories: { best_overall: [], growth: [], value: [], quality: [], hidden_gem: [], caution: [] },
        rows: {}
      },
      { status: 500 }
    );
  }
}
