import { describe, expect, it, vi } from "vitest";
import type { Address, Hash, Hex } from "viem";
import {
  isIssuedWithdrawalSettlement,
  verifyWithdrawalSettlement,
  type WithdrawalChainReader,
  type WithdrawalReceipt,
} from "./withdrawal-verifier";

const source = "0x0000000000000000000000000000000000000030" as Address;
const token = "0x0000000000000000000000000000000000000020" as Address;
const recipient = "0x0000000000000000000000000000000000000040" as Address;
const txHash = ("0x" + "a".repeat(64)) as Hash;
const blockHash = ("0x" + "b".repeat(64)) as Hash;
const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;
const topicAddress = (address: Address) => ("0x" + address.slice(2).toLowerCase().padStart(64, "0")) as Hex;

function fixture(status: "success" | "reverted" = "success") {
  const receipt: WithdrawalReceipt = {
    transactionHash: txHash,
    status,
    blockNumber: 100n,
    blockHash,
    gasUsed: 21_000n,
    effectiveGasPrice: 100n,
    logs: status === "success" ? [{
      address: token,
      data: ("0x" + BigInt(1234).toString(16).padStart(64, "0")) as Hex,
      topics: [transferTopic, topicAddress(source), topicAddress(recipient)],
      logIndex: 4,
    }] : [],
  };
  const chain: WithdrawalChainReader = {
    getChainId: vi.fn(async () => 137),
    getTransactionReceipt: vi.fn(async () => receipt),
    getTransaction: vi.fn(async () => ({ hash: txHash, from: source, to: token })),
    getBlockNumber: vi.fn(async () => 170n),
    getBlock: vi.fn(async ({ blockNumber }) => ({ number: blockNumber, hash: blockHash, parentHash: blockHash })),
  };
  const request = {
    withdrawalId: "withdrawal-1",
    transactionHash: txHash,
    sourceAddress: source,
    tokenAddress: token,
    recipientAddress: recipient,
    amountBaseUnits: "1234",
    requiredConfirmations: 64,
  };
  return { chain, request, receipt };
}

describe("verifyWithdrawalSettlement", () => {
  it("issues proof only for a canonical successful receipt with exact transfer parameters", async () => {
    const f = fixture();
    const proof = await verifyWithdrawalSettlement(f.chain, f.request);
    expect(isIssuedWithdrawalSettlement(proof)).toBe(true);
    expect(proof).toMatchObject({
      withdrawalId: "withdrawal-1",
      chainId: 137,
      status: "confirmed",
      amountBaseUnits: undefined,
      reservedAmountBaseUnits: "1234",
      actualAmountBaseUnits: "1234",
      logIndex: 4,
      blockNumber: "100",
      confirmations: 71,
      requiredConfirmations: 64,
      gasWei: "2100000",
    });
  });

  it("rejects a non-Polygon RPC", async () => {
    const f = fixture();
    (f.chain.getChainId as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    await expect(verifyWithdrawalSettlement(f.chain, f.request)).rejects.toThrow(/chain ID 137/);
  });

  it("rejects a noncanonical receipt block", async () => {
    const f = fixture();
    (f.chain.getBlock as ReturnType<typeof vi.fn>).mockResolvedValue({
      number: 100n,
      hash: ("0x" + "c".repeat(64)) as Hash,
      parentHash: blockHash,
    });
    await expect(verifyWithdrawalSettlement(f.chain, f.request)).rejects.toThrow(/not canonical/);
  });

  it("rejects a receipt whose Transfer amount does not match the reservation", async () => {
    const f = fixture();
    f.receipt.logs = [{
      address: token,
      data: ("0x" + BigInt(1235).toString(16).padStart(64, "0")) as Hex,
      topics: [transferTopic, topicAddress(source), topicAddress(recipient)],
      logIndex: 4,
    }];
    await expect(verifyWithdrawalSettlement(f.chain, f.request)).rejects.toThrow(/exactly one matching token Transfer/);
  });

  it("keeps reverted principal at zero while preserving exact gas cost", async () => {
    const f = fixture("reverted");
    const proof = await verifyWithdrawalSettlement(f.chain, f.request);
    expect(proof.status).toBe("reverted");
    expect(proof.reservedAmountBaseUnits).toBe("1234");
    expect(proof.actualAmountBaseUnits).toBe("0");
    expect(proof.logIndex).toBeNull();
    expect(proof.gasWei).toBe("2100000");
  });

  it("does not treat caller-created proof-shaped objects as trusted", () => {
    expect(isIssuedWithdrawalSettlement({
      withdrawalId: "withdrawal-1",
      chainId: 137,
      transactionHash: txHash,
      status: "confirmed",
    })).toBe(false);
  });
});
