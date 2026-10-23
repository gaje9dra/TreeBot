import { loadConfig } from "../config";
import { realizedVolatility, rsi, sma, validateCandles } from "./indicators";
import type { MarketSnapshot, PortfolioState, RiskLimits, TradeDecision } from "./types";

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  minimumCapitalPol: 150, gasReservePol: 2, maximumTradePol: 5,
  maximumDailyLossPercent: 2, maximumDrawdownPercent: 8,
  maximumSlippageBps: 50, minimumExpectedNetReturnBps: 30,
  maximumTradesPerHour: 4, maximumConsecutiveLosses: 3,
  maximumPairExposurePercent: 20, maximumGasSpendQuote: 15,
  minimumLiquidityUsd: 25_000, maximumPriceImpactBps: 100,
  maximumDataAgeMs: 30_000
};

export interface EvaluateInput {
  market: MarketSnapshot;
  portfolio: PortfolioState;
  limits?: RiskLimits;
  availableCapitalPol: number;
  now?: number;
}

export function evaluateOpportunity(input: EvaluateInput): TradeDecision {
  const { market, portfolio } = input;
  const limits = input.limits ?? DEFAULT_RISK_LIMITS;
  const now = input.now ?? Date.now();
  const reasons: string[] = [];
  const age = now - market.observedAt;
  const candles = market.candles ?? [];
  const dataErrors = validateCandles(candles);
  if (age < 0 || age > limits.maximumDataAgeMs) reasons.push("Market data is stale or timestamp is invalid.");
  if (!market.pair || !market.baseToken || !market.quoteToken) reasons.push("Trading pair or token identity is missing.");
  if (![market.price, market.volume24h, market.liquidityUsd, market.gasCostQuote, market.swapFeeBps, market.expectedSlippageBps].every(Number.isFinite)) reasons.push("Market snapshot contains non-finite values.");
  if (market.price <= 0 || market.volume24h < 0 || market.liquidityUsd < limits.minimumLiquidityUsd) reasons.push("Price, volume, or liquidity is outside minimum requirements.");
  if (market.expectedSlippageBps < 0 || market.expectedSlippageBps > limits.maximumSlippageBps || market.expectedSlippageBps > limits.maximumPriceImpactBps) reasons.push("Estimated slippage or price impact exceeds configured limit.");
  if (market.gasCostQuote < 0 || market.swapFeeBps < 0) reasons.push("Cost inputs cannot be negative.");
  if (!market.executableExit) reasons.push("No acceptable executable exit route is available.");
  if (dataErrors.length) reasons.push(...dataErrors);
  if (portfolio.equityQuote <= 0) reasons.push("Portfolio equity is not positive.");
  const dailyLoss = portfolio.dailyStartEquityQuote > 0 ? Math.max(0, (portfolio.dailyStartEquityQuote - portfolio.equityQuote) / portfolio.dailyStartEquityQuote * 100) : 100;
  const drawdown = portfolio.peakEquityQuote > 0 ? Math.max(0, (portfolio.peakEquityQuote - portfolio.equityQuote) / portfolio.peakEquityQuote * 100) : 100;

  const closes = candles.map((c) => c.close);
  const shortMa = sma(closes, 7);
  const longMa = sma(closes, 21);
  const momentum = rsi(closes, 14);
  const volatility = realizedVolatility(candles);
  if (shortMa === null || longMa === null || momentum === null || volatility === null) reasons.push("Insufficient validated history for the strategy indicators.");

  let grossBps = 0;
  let score = 0;
  let direction: "buy" | "sell" | "hold" = "hold";
  if (shortMa !== null && longMa !== null && momentum !== null && volatility !== null && market.price > 0) {
    const trendBps = (shortMa / longMa - 1) * 10_000;
    const lastReturnBps = closes.length > 1 ? (closes.at(-1)! / closes.at(-2)! - 1) * 10_000 : 0;
    score = Math.max(-100, Math.min(100, trendBps * 0.5 + lastReturnBps * 0.25 + (50 - momentum) * 0.4));
    if (shortMa > longMa && momentum >= 45 && momentum <= 68 && lastReturnBps > 0) direction = "buy";
    else if (shortMa < longMa && momentum >= 32 && momentum <= 55 && lastReturnBps < 0) direction = "sell";
    else reasons.push("Trend and momentum filters do not align; prefer no trade.");
    // Explicitly conservative expected edge proxy, not a prediction/probability.
    grossBps = Math.max(0, Math.abs(trendBps) * 0.25 + Math.abs(lastReturnBps) * 0.2 - volatility * 10_000 * 0.5);
  }

  const currentLong = portfolio.openPositions.find((p) => p.pair === market.pair && p.direction === "long");
  const positionReturn = currentLong?.entryPrice && currentLong.entryPrice > 0
    ? market.price / currentLong.entryPrice - 1
    : null;
  // Paper-mode exits: stop at a 3% loss and take profit at a 5% gain.
  // These still pass the market-integrity and executable-exit gates above.
  if (positionReturn !== null && (positionReturn <= -0.03 || positionReturn >= 0.05)) {
    direction = "sell";
  }

  const pairExposure = portfolio.openPositions.filter((p) => p.pair === market.pair).reduce((s, p) => s + p.notionalQuote, 0);
  const proposedNotional = direction === "sell"
    ? pairExposure
    : Math.min(input.availableCapitalPol, limits.maximumTradePol, portfolio.availableQuote);
  const costsBps = market.swapFeeBps * 2 + market.expectedSlippageBps * 2;
  const gasBps = proposedNotional > 0 ? market.gasCostQuote / proposedNotional * 10_000 : Number.POSITIVE_INFINITY;
  const totalCostBps = costsBps + gasBps;
  const netBps = grossBps - totalCostBps;

  // Entry controls must never prevent a risk-reducing exit from closing an existing long.
  if (direction !== "sell") {
    if (portfolio.availableQuote <= 0) reasons.push("No positive available portfolio equity.");
    if (dailyLoss >= limits.maximumDailyLossPercent) reasons.push("Maximum daily loss limit reached.");
    if (drawdown >= limits.maximumDrawdownPercent) reasons.push("Maximum portfolio drawdown limit reached.");
    if (portfolio.consecutiveLosses >= limits.maximumConsecutiveLosses) reasons.push("Maximum consecutive losses reached.");
    if (portfolio.tradesLastHour >= limits.maximumTradesPerHour) reasons.push("Trade frequency limit reached.");
    if (portfolio.gasSpentQuote >= limits.maximumGasSpendQuote) reasons.push("Gas expenditure limit reached.");
    if (input.availableCapitalPol < limits.minimumCapitalPol + limits.gasReservePol) reasons.push("Available wallet capital is below minimum plus reserved gas.");
    if (proposedNotional <= 0 || proposedNotional > input.availableCapitalPol - limits.gasReservePol) reasons.push("Proposed notional exceeds gas-adjusted capital.");
    if (portfolio.equityQuote > 0 && (pairExposure + proposedNotional) / portfolio.equityQuote * 100 > limits.maximumPairExposurePercent) reasons.push("Pair exposure limit would be exceeded.");
    if (netBps < limits.minimumExpectedNetReturnBps) reasons.push("Expected net return does not exceed the required edge after estimated costs.");
  } else if (direction === "sell") {
    if (pairExposure <= 0 || proposedNotional <= 0) reasons.push("No open long position exists to close; short selling is not supported.");
  }
  if (direction === "hold") reasons.push("No actionable directional signal.");
  const accepted = reasons.length === 0 && (direction === "buy" || direction === "sell");
  if (!accepted && !reasons.length) reasons.push("Candidate did not pass all approval gates.");
  return {
    id: `decision-${now}-${market.pair}`, timestamp: now, pair: market.pair,
    action: accepted ? direction : "skip", score, proposedNotionalQuote: Math.max(0, proposedNotional),
    expectedGrossReturnBps: grossBps, estimatedCostBps: totalCostBps,
    expectedNetReturnBps: netBps, riskRewardRatio: null, dataAgeMs: age, reasons, accepted
  };
}

/** Hard server-side guard: actual execution is intentionally unavailable in this build. */
export function assertExecutionDisabled(): never {
  const config = loadConfig();
  if (config.tradingMode !== "paper" || config.liveTradingEnabled) throw new Error("Live execution is not implemented or authorized. TreeBot supports paper trading only.");
  throw new Error("Live execution is disabled. Use the paper-trading adapter.");
}
