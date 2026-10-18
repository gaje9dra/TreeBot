import { describe, expect, it } from "vitest";
import { PaperBroker } from "./paper-broker";
import type { TradeDecision } from "./types";

const decision: TradeDecision = {
  id: "d-1", timestamp: 100, pair: "A/B", action: "buy", score: 10,
  proposedNotionalQuote: 100, expectedGrossReturnBps: 100, estimatedCostBps: 10,
  expectedNetReturnBps: 90, riskRewardRatio: null, dataAgeMs: 5,
  reasons: [], accepted: true
};

describe("PaperBroker", () => {
  it("marks fills as simulated and applies fees/slippage", () => {
    const broker = new PaperBroker({ feeBps: 30, slippageBps: 20 });
    const trade = broker.execute(decision, 2, 101);
    expect(trade.simulated).toBe(true);
    expect(trade.status).toBe("simulated");
    expect(trade.feesQuote).toBeCloseTo(0.3);
    expect(trade.executionPrice).toBeCloseTo(2.004);
  });
  it("is idempotent for repeated decision identifiers", () => {
    const broker = new PaperBroker();
    const first = broker.execute(decision, 2, 101);
    expect(broker.execute(decision, 3, 102)).toEqual(first);
    expect(broker.list()).toHaveLength(1);
  });
  it("rejects unapproved decisions and invalid prices", () => {
    const broker = new PaperBroker();
    expect(() => broker.execute({ ...decision, accepted: false }, 2)).toThrow();
    expect(() => broker.execute(decision, 0)).toThrow();
  });
});
