import type {
  ScreenerRow,
  OhlcvBar,
  HistoryData,
  BrokerRow,
  BrokerSummaryData,
  BrokerAccumulationData,
  AnalysisData,
  SeasonalData,
  MarketCapEntry,
  SearchResultEntry,
  FinancialStatementData,
  InsiderTransaction,
  HealthStatus
} from "@idx/domain";
import type {
  ScreenerLatestResponse,
  HistoryResponse,
  BrokerSummaryResponse,
  BrokerAccumulationResponse,
  AnalysisResponse,
  SeasonalResponse,
  MarketCapResponse,
  SearchResponse,
  HealthResponse,
  FinancialStatementResponse,
  InsidersResponse
} from "@idx/domain";

/**
 * Pure mappers from upstream (snake_case, provisional Zod) shapes to the
 * shared domain contracts in packages/domain/src/types/marketData.ts. No
 * envelope/audit concerns here — see envelope.ts and endpoints.ts.
 */

export function normalizeScreenerRow(row: ScreenerLatestResponse["data"][number]): ScreenerRow {
  const bestBid = row.best_bid ?? null;
  const bestOffer = row.best_offer ?? null;
  return {
    symbol: row.symbol,
    board: row.board ?? null,
    price: Number(row.price),
    priceChange: row.change !== undefined ? Number(row.change) : 0,
    priceChangePct: row.change_pct !== undefined ? Number(row.change_pct) : 0,
    volume: Number(row.volume),
    turnover: Number(row.turnover),
    bestBid: bestBid !== null ? Number(bestBid) : null,
    bestOffer: bestOffer !== null ? Number(bestOffer) : null,
    spread: bestBid !== null && bestOffer !== null ? Number(bestOffer) - Number(bestBid) : null,
    isSuspended: row.is_suspended ?? false,
    notation: row.notation ?? null
  };
}

export function normalizeOhlcvBar(bar: HistoryResponse["bars"][number]): OhlcvBar {
  return {
    date: bar.date,
    open: Number(bar.open),
    high: Number(bar.high),
    low: Number(bar.low),
    close: Number(bar.close),
    volume: Number(bar.volume),
    turnover: bar.turnover !== undefined && bar.turnover !== null ? Number(bar.turnover) : null
  };
}

export function normalizeHistory(resp: HistoryResponse): HistoryData {
  return {
    symbol: resp.symbol,
    bars: resp.bars.map(normalizeOhlcvBar),
    baselineMedianVolume20d:
      resp.baseline_median_volume_20d !== undefined && resp.baseline_median_volume_20d !== null
        ? Number(resp.baseline_median_volume_20d)
        : null
  };
}

function normalizeBrokerRow(row: BrokerSummaryResponse["brokers"][number]): BrokerRow {
  const buyVolume = Number(row.buy_volume);
  const sellVolume = Number(row.sell_volume);
  const buyValue = Number(row.buy_value);
  const sellValue = Number(row.sell_value);
  return {
    brokerCode: row.broker_code,
    buyVolume,
    buyValue,
    sellVolume,
    sellValue,
    netVolume: row.net_volume !== undefined ? Number(row.net_volume) : buyVolume - sellVolume,
    netValue: row.net_value !== undefined ? Number(row.net_value) : buyValue - sellValue,
    avgBuyPrice: row.avg_buy_price !== undefined && row.avg_buy_price !== null ? Number(row.avg_buy_price) : null,
    avgSellPrice: row.avg_sell_price !== undefined && row.avg_sell_price !== null ? Number(row.avg_sell_price) : null
  };
}

export function normalizeBrokerSummary(resp: BrokerSummaryResponse): BrokerSummaryData {
  const brokers = resp.brokers.map(normalizeBrokerRow);
  return {
    symbol: resp.symbol,
    segment: resp.segment ?? "unknown",
    brokers,
    totalVolume: brokers.reduce((sum, b) => sum + b.buyVolume + b.sellVolume, 0),
    totalValue: brokers.reduce((sum, b) => sum + b.buyValue + b.sellValue, 0)
  };
}

export function normalizeBrokerAccumulation(resp: BrokerAccumulationResponse): BrokerAccumulationData {
  return {
    symbol: resp.symbol,
    windowDays: resp.window_days ?? resp.days.length,
    days: resp.days.map((d) => ({
      date: d.date,
      netBuyBrokers: d.net_buy_brokers,
      topBuyerCode: d.top_buyer_code ?? null,
      topBuyerShare: d.top_buyer_share !== undefined && d.top_buyer_share !== null ? Number(d.top_buyer_share) : null
    }))
  };
}

export function normalizeAnalysis(resp: AnalysisResponse): AnalysisData {
  return {
    symbol: resp.symbol,
    sector: resp.sector ?? null,
    marketCap: resp.market_cap !== undefined && resp.market_cap !== null ? Number(resp.market_cap) : null,
    narrative: null
  };
}

export function normalizeSeasonal(resp: SeasonalResponse): SeasonalData {
  return {
    symbol: resp.symbol,
    month: resp.month,
    historicalWinRate:
      resp.historical_win_rate !== undefined && resp.historical_win_rate !== null
        ? Number(resp.historical_win_rate)
        : null,
    sampleSize: resp.sample_size ?? 0
  };
}

export function normalizeMarketCapEntries(resp: MarketCapResponse): MarketCapEntry[] {
  return resp.data.map((e) => ({
    symbol: e.symbol,
    sharesOutstanding: Number(e.shares_outstanding),
    marketCap: Number(e.market_cap)
  }));
}

export function normalizeSearchResults(resp: SearchResponse): SearchResultEntry[] {
  return resp.data.map((e) => ({ symbol: e.symbol, name: e.name }));
}

export function normalizeHealth(resp: HealthResponse): HealthStatus {
  return {
    upstreamOk: resp.status.toLowerCase() === "ok" || resp.status.toLowerCase() === "healthy",
    latencyMs: resp.latency_ms !== undefined && resp.latency_ms !== null ? Number(resp.latency_ms) : null,
    message: resp.message ?? null
  };
}

export function normalizeFinancialStatement(resp: FinancialStatementResponse): FinancialStatementData {
  return {
    symbol: resp.symbol,
    fiscalPeriod: resp.fiscal_period,
    revenue: resp.revenue !== undefined && resp.revenue !== null ? Number(resp.revenue) : null,
    netIncome: resp.net_income !== undefined && resp.net_income !== null ? Number(resp.net_income) : null,
    debtToEquity: resp.debt_to_equity !== undefined && resp.debt_to_equity !== null ? Number(resp.debt_to_equity) : null,
    redFlags: resp.red_flags ?? []
  };
}

export function normalizeInsiderTransaction(t: InsidersResponse["data"][number]): InsiderTransaction {
  return {
    symbol: t.symbol,
    date: t.date,
    insiderName: t.insider_name ?? null,
    action: t.action,
    shares: Number(t.shares)
  };
}

export function normalizeInsiders(resp: InsidersResponse): InsiderTransaction[] {
  return resp.data.map(normalizeInsiderTransaction);
}
