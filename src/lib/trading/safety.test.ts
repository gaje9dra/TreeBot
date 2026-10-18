import { describe, expect, it } from "vitest";
import { tradingReadiness } from "./safety";

const ready = {
  connected: true, chainId: 137, eligibleCapital: true, marketDataHealthy: true,
  rpcHealthy: true, emergencyStop: false, mode: "paper" as const, explicitOwnerAuthorization: true
};

describe("execution readiness", () => {
  it("does not allow live mode even if the remaining checks pass", () => {
    const result = tradingReadiness({ ...ready, mode: "live" });
    expect(result.canTrade).toBe(false);
    expect(result.blockers.some((b) => b.includes("not implemented"))).toBe(true);
  });
  it("blocks on emergency stop and stale feeds", () => {
    const result = tradingReadiness({ ...ready, emergencyStop: true, marketDataHealthy: false });
    expect(result.canTrade).toBe(false);
    expect(result.blockers).toContain("Emergency stop is active.");
    expect(result.blockers).toContain("Market data is not healthy or fresh.");
  });
  it("only reports readiness for paper mode when every gate passes", () => {
    expect(tradingReadiness(ready).canTrade).toBe(true);
  });
});
