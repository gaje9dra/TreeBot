import { describe, expect, it } from "vitest";
import { backtest } from "./backtest";
import type { Candle } from "./types";

const candles: Candle[] = Array.from({ length: 80 }, (_, i) => {
  const close = 100 + Math.sin(i / 5) * 2 + i * .15;
  return { timestamp: 1_700_000_000_000 + i * 60_000, open: close - .1, high: close + .5, low: close - .5, close, volume: 1_000_000 };
});

describe("historical backtest", () => {
  it("returns explicitly simulated results and cost breakdown", () => {
    const report = backtest(candles, { startingEquityQuote: 1000, notionalQuote: 50, feeBps: 30, slippageBps: 20, gasQuotePerTrade: .05 });
    expect(report.simulated).toBe(true);
    expect(report.finalEquityQuote).toBeTypeOf("number");
    expect(report.maximumDrawdownPercent).toBeGreaterThanOrEqual(0);
    expect(report.feesQuote).toBeGreaterThanOrEqual(0);
    expect(report.slippageQuote).toBeGreaterThanOrEqual(0);
    expect(report.gasQuote).toBeGreaterThanOrEqual(0);
    expect(report.notes.some((n) => n.includes("not actual earnings"))).toBe(true);
    expect(report.notes.some((n) => n.includes("must not be deducted twice"))).toBe(true);
  });
  it("rejects too little history and invalid costs", () => {
    expect(() => backtest(candles.slice(0, 10), { startingEquityQuote: 100, notionalQuote: 10, feeBps: 1, slippageBps: 1, gasQuotePerTrade: 0 })).toThrow();
    expect(() => backtest(candles, { startingEquityQuote: 100, notionalQuote: 10, feeBps: -1, slippageBps: 1, gasQuotePerTrade: 0 })).toThrow();
  });
});
