import { describe, expect, it } from "vitest";
import { buildWithdrawalUnknownIncident } from "./withdrawal-incidents";

const base = {
  accountId: "account-1",
  assetAddress: "0x0000000000000000000000000000000000000020",
  amountBaseUnits: "1250",
  withdrawalId: "withdrawal-123",
  transactionHash: "0x" + "a".repeat(64),
  nonce: 7,
  reason: "provider timed out after broadcast may have started",
};

describe("unknown withdrawal incident identity", () => {
  it("builds a deterministic incident with normalized chain evidence", () => {
    expect(buildWithdrawalUnknownIncident(base)).toEqual({
      incidentKey: "withdrawal-submission-unknown:137:withdrawal-123",
      accountId: "account-1",
      assetAddress: base.assetAddress,
      amountBaseUnits: "1250",
      transactionHash: base.transactionHash,
      nonce: 7,
      reason: base.reason,
    });
  });

  it("retains an explicit unresolved hash when the provider returned no hash", () => {
    expect(buildWithdrawalUnknownIncident({ ...base, transactionHash: null, nonce: null }))
      .toMatchObject({ transactionHash: null, nonce: null });
  });

  it("rejects malformed monetary values and transaction identity", () => {
    expect(() => buildWithdrawalUnknownIncident({ ...base, amountBaseUnits: "0" })).toThrow(/positive base units/);
    expect(() => buildWithdrawalUnknownIncident({ ...base, transactionHash: "not-a-hash" })).toThrow(/transaction hash/);
    expect(() => buildWithdrawalUnknownIncident({ ...base, nonce: -1 })).toThrow(/nonce/);
    expect(() => buildWithdrawalUnknownIncident({ ...base, assetAddress: "not-an-address" })).toThrow(/token address/);
  });

  it("bounds operator/RPC error text before it becomes durable incident evidence", () => {
    const incident = buildWithdrawalUnknownIncident({ ...base, reason: "x".repeat(900) });
    expect(incident.reason).toHaveLength(500);
  });
});
