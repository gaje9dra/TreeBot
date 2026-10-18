import { describe, expect, it, vi } from "vitest";
import { runPaperCycle, type PaperLedger } from "./paper-cycle";
import type { MarketSnapshot, PortfolioState, TradeDecision } from "@/lib/trading/types";

const now = 1_800_000_000_000;
const market: MarketSnapshot = {
  pair: "WMATIC/USDC",
  baseToken: "0x0000000000000000000000000000000000000001",
  quoteToken: "0x0000000000000000000000000000000000000002",
  observedAt: now,
  price: 100,
  volume24h: 50_000,
  liquidityUsd: 100_000,
  gasCostQuote: 0.02,
  swapFeeBps: 30,
  expectedSlippageBps: 20,
  executableExit: true,
  candles: Array.from({ length: 25 }, (_, i) => ({
    timestamp: now - (24 - i) * 60_000,
    open: 100 + i,
    high: 102 + i,
    low: 99 + i,
    close: 101 + i,
    volume: 1_000,
  })),
};
const portfolio: PortfolioState = {
  equityQuote: 1_000,
  availableQuote: 1_000,
  reservedQuote: 0,
  dailyStartEquityQuote: 1_000,
  peakEquityQuote: 1_000,
  openPositions: [],
  consecutiveLosses: 0,
  tradesLastHour: 0,
  gasSpentQuote: 0,
};
const decision: TradeDecision = {
  id: "decision-1",
  timestamp: now,
  pair: market.pair,
  action: "buy",
  score: 25,
  proposedNotionalQuote: 100,
  expectedGrossReturnBps: 150,
  estimatedCostBps: 20,
  expectedNetReturnBps: 130,
  riskRewardRatio: null,
  dataAgeMs: 0,
  reasons: [],
  accepted: true,
};

function makeLedger(control: { enabled: boolean; emergencyStop: boolean }) {
  return {
    getControl: vi.fn(async () => ({ ...control, lastHeartbeatAt: null })),
    recordHeartbeat: vi.fn(async () => undefined),
    getPortfolio: vi.fn(async () => portfolio),
    recordDecision: vi.fn(async () => ({ tradeRecorded: true })),
  };
}

describe("paper worker cycle", () => {
  it("does not fetch market data when disabled or emergency-stopped", async () => {
    const ledger = makeLedger({ enabled: false, emergencyStop: false });
    const marketLoader = vi.fn(async () => market);
    const result = await runPaperCycle(market.pair, now, {
      ledger: ledger as unknown as PaperLedger,
      marketLoader,
    });
    expect(result).toEqual({ status: "paused", reason: "Paper trading is disabled." });
    expect(marketLoader).not.toHaveBeenCalled();
    expect(ledger.recordHeartbeat).toHaveBeenCalledOnce();
    expect(ledger.recordDecision).not.toHaveBeenCalled();
  });

  it("evaluates fresh provider data and persists an idempotent simulated decision", async () => {
    const ledger = makeLedger({ enabled: true, emergencyStop: false });
    const marketLoader = vi.fn(async () => market);
    const evaluate = vi.fn(() => decision);
    const result = await runPaperCycle(market.pair, now, {
      ledger: ledger as unknown as PaperLedger,
      marketLoader,
      evaluate,
      env: { TREEBOT_PAPER_MAX_NOTIONAL_QUOTE: "100" },
    });
    expect(result.status).toBe("evaluated");
    expect(marketLoader).toHaveBeenCalledOnce();
    expect(ledger.recordHeartbeat).toHaveBeenCalledOnce();
    expect(evaluate).toHaveBeenCalledOnce();
    expect(ledger.getPortfolio).toHaveBeenCalledWith(market.pair, market.price, now);
    expect(ledger.recordDecision).toHaveBeenCalledWith(market, decision, now);
  });
});
