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
  it("keeps deposits hard-disabled until the release gate and operator prerequisites are approved", () => {
    expect(() => loadConfig({ TREEBOT_DEPOSITS_ENABLED: "true" })).toThrow(/Deposits are disabled/);
    expect(() => loadConfig({
      TREEBOT_DEPOSITS_ENABLED: "true",
      TREEBOT_DEPOSITS_OPERATOR_APPROVED: "true",
      TREEBOT_DEPOSITS_SECURITY_REVIEWED: "true",
      TREEBOT_DEPOSITS_NETWORK_VERIFIED: "true",
      TREEBOT_DEPOSIT_ALERT_WEBHOOK: "https://alerts.example.test/treebot",
    })).toThrow(/Deposits are disabled in this build/);
  });
});
