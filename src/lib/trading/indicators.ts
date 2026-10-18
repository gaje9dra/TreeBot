import type { Candle } from "./types";

export function sma(values: number[], period: number): number | null {
  if (!Number.isInteger(period) || period <= 0 || values.length < period) return null;
  const sample = values.slice(-period);
  if (sample.some((v) => !Number.isFinite(v))) return null;
  return sample.reduce((a, b) => a + b, 0) / period;
}

export function rsi(closes: number[], period = 14): number | null {
  if (!Number.isInteger(period) || period <= 0 || closes.length < period + 1) return null;
  const values = closes.slice(-(period + 1));
  if (values.some((v) => !Number.isFinite(v) || v <= 0)) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    if (delta > 0) gains += delta;
    else losses -= delta;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function realizedVolatility(candles: Candle[]): number | null {
  if (candles.length < 3) return null;
  const returns: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const previous = candles[i - 1].close;
    const current = candles[i].close;
    if (previous <= 0 || current <= 0 || !Number.isFinite(previous + current)) return null;
    returns.push(Math.log(current / previous));
  }
  const mean = returns.reduce((sum, item) => sum + item, 0) / returns.length;
  const variance = returns.reduce((sum, item) => sum + (item - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

export function validateCandles(candles: Candle[]): string[] {
  const errors: string[] = [];
  if (candles.length < 2) errors.push("Insufficient candle history.");
  for (const [index, candle] of candles.entries()) {
    if (![candle.timestamp, candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)) errors.push(`Candle ${index} contains non-finite values.`);
    if (candle.close <= 0 || candle.open <= 0 || candle.low <= 0) errors.push(`Candle ${index} contains a non-positive price.`);
    if (candle.high < Math.max(candle.open, candle.close, candle.low)) errors.push(`Candle ${index} has inconsistent high.`);
    if (candle.low > Math.min(candle.open, candle.close)) errors.push(`Candle ${index} has inconsistent low.`);
    if (candle.volume < 0) errors.push(`Candle ${index} has negative volume.`);
    if (index > 0 && candle.timestamp <= candles[index - 1].timestamp) errors.push("Candle timestamps must be strictly increasing.");
  }
  return errors;
}
