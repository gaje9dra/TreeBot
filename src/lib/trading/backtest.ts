import { evaluateOpportunity, DEFAULT_RISK_LIMITS } from "./decision-engine";
import type { Candle, MarketSnapshot, PortfolioState, RiskLimits } from "./types";

export interface BacktestOptions {
  startingEquityQuote: number;
  notionalQuote: number;
  feeBps: number;
  slippageBps: number;
  gasQuotePerTrade: number;
  minimumCapitalPol?: number;
  limits?: RiskLimits;
}
export interface BacktestReport {
  simulated: true;
  tradeCount: number;
  winRate: number;
  netReturnPercent: number;
  maximumDrawdownPercent: number;
  averageWinQuote: number;
  averageLossQuote: number;
  profitFactor: number | null;
  netExpectancyQuote: number;
  feesQuote: number;
  slippageQuote: number;
  gasQuote: number;
  finalEquityQuote: number;
  benchmarkReturnPercent: number;
  notes: string[];
}

/**
 * Conservative close-to-close bar replay. Signals are computed on history available
 * up to the current bar. This is research tooling, not a claim of executable live fills.
 */
export function backtest(candles: Candle[], options: BacktestOptions): BacktestReport {
  if (candles.length < 25) throw new Error("Backtest requires at least 25 candles.");
  if (![options.startingEquityQuote, options.notionalQuote, options.feeBps, options.slippageBps, options.gasQuotePerTrade].every(Number.isFinite)) throw new Error("Backtest inputs must be finite.");
  if (options.startingEquityQuote <= 0 || options.notionalQuote <= 0 || [options.feeBps, options.slippageBps, options.gasQuotePerTrade].some(v => v < 0)) throw new Error("Backtest inputs are outside valid ranges.");
  const initial = options.startingEquityQuote;
  let equity = initial;
  let peak = equity;
  let maxDrawdown = 0;
  let position: { entry: number; notional: number } | null = null;
  const pnl: number[] = [];
  let fees = 0, slippage = 0, gas = 0;
  const limits = options.limits ?? DEFAULT_RISK_LIMITS;

  for (let i = 22; i < candles.length - 1; i++) {
    const window = candles.slice(0, i + 1);
    const current = candles[i];
    const next = candles[i + 1];
    const market: MarketSnapshot = {
      pair: "BACKTEST/QUOTE", baseToken: "BACKTEST", quoteToken: "QUOTE",
      observedAt: current.timestamp, price: current.close, volume24h: current.volume,
      liquidityUsd: Number.MAX_SAFE_INTEGER, gasCostQuote: options.gasQuotePerTrade,
      swapFeeBps: options.feeBps, expectedSlippageBps: options.slippageBps,
      executableExit: true, candles: window
    };
    const portfolio: PortfolioState = {
      equityQuote: equity, availableQuote: equity, reservedQuote: position?.notional ?? 0,
      dailyStartEquityQuote: equity, peakEquityQuote: peak,
      openPositions: position ? [{ pair: market.pair, notionalQuote: position.notional, direction: "long" }] : [],
      consecutiveLosses: 0, tradesLastHour: 0, gasSpentQuote: gas
    };
    const decision = evaluateOpportunity({
      market, portfolio, availableCapitalPol: Math.min(equity, limits.minimumCapitalPol + limits.gasReservePol),
      limits: { ...limits, minimumCapitalPol: 0, gasReservePol: 0, maximumPairExposurePercent: 100 },
      now: current.timestamp
    });
    // Execute at next bar open with explicit one-way slippage on each side.
    let openedAtNextBar = false;
    if (!position && decision.accepted && decision.action === "buy") {
      const notional = Math.min(options.notionalQuote, equity);
      if (notional <= 0) continue;
      const fee = notional * options.feeBps / 10_000;
      const slip = notional * options.slippageBps / 10_000;
      fees += fee; slippage += slip; gas += options.gasQuotePerTrade;
      // Slippage is already reflected in the adverse entry fill price; do not deduct it from equity a second time.
      equity -= fee + options.gasQuotePerTrade;
      position = { entry: next.open * (1 + options.slippageBps / 10_000), notional };
      openedAtNextBar = true;
    } else if (position && (decision.action === "sell" || current.close <= position.entry * 0.97 || current.close >= position.entry * 1.05 || i === candles.length - 2)) {
      const exit = next.open * (1 - options.slippageBps / 10_000);
      const exitNotional = position.notional * (exit / position.entry);
      const gross = exitNotional - position.notional;
      const fee = exitNotional * options.feeBps / 10_000;
      const slip = position.notional * (next.open / position.entry) * options.slippageBps / 10_000;
      // Slippage is reflected in the adverse exit fill price; report it, but do not deduct it twice.
      const net = gross - fee - options.gasQuotePerTrade;
      equity += net;
      pnl.push(net); fees += fee; slippage += slip; gas += options.gasQuotePerTrade;
      position = null;
    }
    // Mark open positions to market so drawdown includes unrealized losses.
    const markedEquity = position && !openedAtNextBar
      ? equity + (current.close / position.entry - 1) * position.notional
      : equity;
    peak = Math.max(peak, markedEquity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - markedEquity) / peak * 100);
  }
  if (position) {
    const last = candles.at(-1)!;
    const exitPrice = last.close * (1 - options.slippageBps / 10_000);
    const exitNotional = position.notional * (exitPrice / position.entry);
    const gross = exitNotional - position.notional;
    const exitFee = exitNotional * options.feeBps / 10_000;
    const exitSlippage = position.notional * (last.close / position.entry) * options.slippageBps / 10_000;
    // The adverse final exit fill already includes slippage; do not deduct it twice.
    const net = gross - exitFee - options.gasQuotePerTrade;
    equity += net;
    pnl.push(net);
    fees += exitFee;
    slippage += exitSlippage;
    gas += options.gasQuotePerTrade;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak * 100);
  }
  const wins = pnl.filter(v => v > 0), losses = pnl.filter(v => v < 0);
  const totalWins = wins.reduce((a,b) => a+b, 0);
  const totalLosses = -losses.reduce((a,b) => a+b, 0);
  const firstPrice = candles[0].close, lastPrice = candles.at(-1)!.close;
  return {
    simulated: true, tradeCount: pnl.length, winRate: pnl.length ? wins.length / pnl.length * 100 : 0,
    netReturnPercent: (equity / initial - 1) * 100, maximumDrawdownPercent: maxDrawdown,
    averageWinQuote: wins.length ? totalWins / wins.length : 0,
    averageLossQuote: losses.length ? losses.reduce((a,b)=>a+b,0) / losses.length : 0,
    profitFactor: totalLosses > 0 ? totalWins / totalLosses : wins.length ? null : 0,
    netExpectancyQuote: pnl.length ? pnl.reduce((a,b)=>a+b,0) / pnl.length : 0,
    feesQuote: fees, slippageQuote: slippage, gasQuote: gas, finalEquityQuote: equity,
    benchmarkReturnPercent: (lastPrice / firstPrice - 1) * 100,
    notes: ["SIMULATED historical replay only; not actual earnings.", "Uses next-bar open for entries/exits to reduce look-ahead bias.", "Slippage is reflected in adverse entry/exit fills and must not be deducted twice.", "Liquidity, failed fills, and historical gas conditions remain simplified; validate out of sample."]
  };
}
