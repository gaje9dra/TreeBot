export type TradeAction = "buy" | "sell" | "hold" | "skip";
export type TradingMode = "paper" | "live";
export type MarketHealth = "healthy" | "stale" | "invalid";

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketSnapshot {
  pair: string;
  baseToken: string;
  quoteToken: string;
  observedAt: number;
  price: number;
  bid?: number;
  ask?: number;
  volume24h: number;
  liquidityUsd: number;
  gasCostQuote: number;
  swapFeeBps: number;
  expectedSlippageBps: number;
  executableExit: boolean;
  candles: Candle[];
}

export interface PortfolioState {
  equityQuote: number;
  availableQuote: number;
  reservedQuote: number;
  dailyStartEquityQuote: number;
  peakEquityQuote: number;
  openPositions: Array<{ pair: string; notionalQuote: number; direction: "long" | "short" }>;
  consecutiveLosses: number;
  tradesLastHour: number;
  gasSpentQuote: number;
}

export interface RiskLimits {
  minimumCapitalPol: number;
  gasReservePol: number;
  maximumTradePol: number;
  maximumDailyLossPercent: number;
  maximumDrawdownPercent: number;
  maximumSlippageBps: number;
  minimumExpectedNetReturnBps: number;
  maximumTradesPerHour: number;
  maximumConsecutiveLosses: number;
  maximumPairExposurePercent: number;
  maximumGasSpendQuote: number;
  minimumLiquidityUsd: number;
  maximumPriceImpactBps: number;
  maximumDataAgeMs: number;
}

export interface TradeDecision {
  id: string;
  timestamp: number;
  pair: string;
  action: TradeAction;
  score: number;
  proposedNotionalQuote: number;
  expectedGrossReturnBps: number;
  estimatedCostBps: number;
  expectedNetReturnBps: number;
  riskRewardRatio: number | null;
  dataAgeMs: number;
  reasons: string[];
  accepted: boolean;
}

export interface PaperTrade {
  id: string;
  decisionId: string;
  pair: string;
  side: "buy" | "sell";
  notionalQuote: number;
  executionPrice: number;
  feesQuote: number;
  slippageQuote: number;
  status: "simulated";
  simulated: true;
  timestamp: number;
}

export interface AuditEvent {
  id: string;
  timestamp: number;
  type: string;
  message: string;
  data?: Record<string, string | number | boolean | null>;
}
