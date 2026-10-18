import { describe, expect, it } from "vitest";
import { realizedVolatility, rsi, sma, validateCandles } from "./indicators";
import type { Candle } from "./types";

const candles: Candle[] = Array.from({ length: 22 }, (_, i) => ({
  timestamp: 1_700_000_000_000 + i * 60_000,
  open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 1000 + i
}));

describe("market indicators", () => {
  it("calculates moving average and rejects insufficient history", () => {
    expect(sma([1, 2, 3, 4], 3)).toBe(3);
    expect(sma([1, 2], 3)).toBeNull();
    expect(sma([1, Number.NaN], 2)).toBeNull();
  });
  it("calculates RSI for rising, falling, and flat series", () => {
    expect(rsi([1, 2, 3, 4, 5], 3)).toBe(100);
    expect(rsi([5, 4, 3, 2, 1], 3)).toBe(0);
    expect(rsi([1, 1, 1, 1], 3)).toBe(50);
    expect(rsi([1, 2], 3)).toBeNull();
  });
  it("validates candle structure and increasing timestamps", () => {
    expect(validateCandles(candles)).toEqual([]);
    expect(validateCandles([{ ...candles[0], high: 1 }])).not.toEqual([]);
    expect(validateCandles([candles[0], { ...candles[1], timestamp: candles[0].timestamp }])).toContain("Candle timestamps must be strictly increasing.");
  });
  it("returns finite realized volatility for valid prices", () => {
    expect(realizedVolatility(candles)).toBeTypeOf("number");
    expect(realizedVolatility(candles.slice(0, 2))).toBeNull();
  });
});
