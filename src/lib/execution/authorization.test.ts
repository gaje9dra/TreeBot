import { describe, expect, it } from "vitest";
import { authorizeExecution, assertLiveExecutionUnavailable } from "./authorization";

const owner = "0x0000000000000000000000000000000000000003";
const sell = "0x0000000000000000000000000000000000000001";
const buy = "0x0000000000000000000000000000000000000002";
const target = "0x0000000000000000000000000000000000000004";
const authorization = {
  id: "auth-1", owner, chainId: 137, allowedTokens: [sell, buy], allowedTargets: [target],
  maximumSellAmount: "1000", expiresAt: 2_000_000_000_000, revokedAt: null, authorizedBy: "owner_wallet" as const,
};
const intent = { chainId: 137, owner, sellToken: sell, buyToken: buy, sellAmount: "1000", transactionTarget: target, now: 1_800_000_000_000 };

describe("execution authorization boundary", () => {
  it("allows an intent inside the user-provided scope", () => expect(authorizeExecution(authorization, intent).allowed).toBe(true));
  it("rejects wrong chain, wrong owner, excess amount, expired and revoked authority", () => {
    expect(authorizeExecution(authorization, { ...intent, chainId: 1 }).allowed).toBe(false);
    expect(authorizeExecution(authorization, { ...intent, owner: "0x0000000000000000000000000000000000000005" }).allowed).toBe(false);
    expect(authorizeExecution(authorization, { ...intent, sellAmount: "1001" }).allowed).toBe(false);
    expect(authorizeExecution({ ...authorization, expiresAt: 1 }, intent).allowed).toBe(false);
    expect(authorizeExecution({ ...authorization, revokedAt: 2 }, intent).allowed).toBe(false);
  });
  it("rejects unsupported token and destination", () => {
    expect(authorizeExecution(authorization, { ...intent, buyToken: "0x0000000000000000000000000000000000000005" }).allowed).toBe(false);
    expect(authorizeExecution(authorization, { ...intent, transactionTarget: "0x0000000000000000000000000000000000000005" }).allowed).toBe(false);
  });
  it("keeps server-side live signing hard-disabled", () => expect(assertLiveExecutionUnavailable).toThrow(/hard-disabled/));
});
