import { describe, expect, it } from "vitest";
import { evaluateOpportunity, DEFAULT_RISK_LIMITS } from "./decision-engine";
import type { Candle, MarketSnapshot, PortfolioState } from "./types";

const now = 1_700_000_000_000;
const candles: Candle[] = Array.from({ length: 30 }, (_, i) => {
  const close = 100 + i * 0.4;
  return { timestamp: now - (29 - i) * 60_000, open: close - .1, high: close + .5, low: close - .5, close, volume: 10000 + i * 100 };
});
const market: MarketSnapshot = {
  pair: "TOKEN/POL", baseToken: "TOKEN", quoteToken: "POL", observedAt: now,
  price: candles.at(-1)!.close, volume24h: 1_000_000, liquidityUsd: 1_000_000,
  gasCostQuote: .001, swapFeeBps: 5, expectedSlippageBps: 5, executableExit: true, candles
};
const portfolio: PortfolioState = {
  equityQuote: 1000, availableQuote: 1000, reservedQuote: 0, dailyStartEquityQuote: 1000,
  peakEquityQuote: 1000, openPositions: [], consecutiveLosses: 0, tradesLastHour: 0, gasSpentQuote: 0
};

describe("explainable decision engine", () => {
  it("rejects stale market data", () => {
    const decision = evaluateOpportunity({ market: { ...market, observedAt: now - 100_000 }, portfolio, availableCapitalPol: 200, now });
    expect(decision.accepted).toBe(false);
    expect(decision.reasons.some((r) => r.includes("stale"))).toBe(true);
    expect(decision.action).toBe("skip");
  });
  it("rejects a portfolio at its daily loss limit", () => {
    const decision = evaluateOpportunity({ market, portfolio: { ...portfolio, equityQuote: 970 }, availableCapitalPol: 200, now, limits: DEFAULT_RISK_LIMITS });
    expect(decision.accepted).toBe(false);
    expect(decision.reasons.some((r) => r.includes("daily loss"))).toBe(true);
  });
  it("prefers no trade when capital is below the 150 POL eligibility floor", () => {
    const decision = evaluateOpportunity({ market, portfolio, availableCapitalPol: 100, now });
    expect(decision.accepted).toBe(false);
    expect(decision.reasons.some((r) => r.includes("below minimum"))).toBe(true);
  });
  it("allows an exit when entry risk limits are breached and no free quote cash remains", () => {
    let price = 100;
    const exitCandles: Candle[] = Array.from({ length: 30 }, (_, i) => {
      price += i < 9 ? 2 : i % 2 === 1 ? -0.8 : 0.5;
      return {
        timestamp: now - (29 - i) * 60_000,
        open: price + 0.1,
        high: price + 0.5,
        low: price - 0.5,
        close: price,
        volume: 10_000 + i * 100,
      };
    });
    const exitMarket = { ...market, price: exitCandles.at(-1)!.close, candles: exitCandles };
    const exposedPortfolio: PortfolioState = {
      ...portfolio,
      equityQuote: 970,
      availableQuote: 0,
      reservedQuote: 100,
      dailyStartEquityQuote: 1_000,
      peakEquityQuote: 1_000,
      openPositions: [{ pair: market.pair, notionalQuote: 100, direction: "long" }],
      consecutiveLosses: DEFAULT_RISK_LIMITS.maximumConsecutiveLosses,
      tradesLastHour: DEFAULT_RISK_LIMITS.maximumTradesPerHour,
      gasSpentQuote: DEFAULT_RISK_LIMITS.maximumGasSpendQuote,
    };
    const decision = evaluateOpportunity({
      market: exitMarket,
      portfolio: exposedPortfolio,
      availableCapitalPol: 0,
      now,
      limits: DEFAULT_RISK_LIMITS,
    });
    expect(decision.action).toBe("sell");
    expect(decision.accepted).toBe(true);
    expect(decision.proposedNotionalQuote).toBeGreaterThan(0);
    expect(decision.reasons).toEqual([]);
  });

  it("rejects unavailable exit liquidity", () => {
    const decision = evaluateOpportunity({ market: { ...market, executableExit: false }, portfolio, availableCapitalPol: 200, now });
    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toContain("No acceptable executable exit route is available.");
  });
});
