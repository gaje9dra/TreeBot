import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

describe("configuration safety", () => {
  it("defaults to paper mode and disabled deposits/live execution", () => {
    const c = loadConfig({});
    expect(c.chainId).toBe(137);
    expect(c.tradingMode).toBe("paper");
    expect(c.liveTradingEnabled).toBe(false);
    expect(c.depositsEnabled).toBe(false);
  });
  it("rejects other chains and live mode without an enable flag", () => {
    expect(() => loadConfig({ NEXT_PUBLIC_CHAIN_ID: "1" })).toThrow();
    expect(() => loadConfig({ TREEBOT_TRADING_MODE: "live" })).toThrow();
  });
  it("never permits deposits even if explicitly requested", () => {
    expect(() => loadConfig({ TREEBOT_DEPOSITS_ENABLED: "true" })).toThrow(/Deposits are disabled/);
  });
});
