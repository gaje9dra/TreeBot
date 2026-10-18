import { describe, expect, it } from "vitest";
import type { Address, Hash, Hex } from "viem";
import {
  isIssuedVerifiedTradeSettlement,
  verifyTradeSettlement,
  type TradeReceipt,
  type TradeSettlementReader,
  type TradeSettlementRequest,
} from "./trade-settlement-verifier";

const wallet = "0x0000000000000000000000000000000000000003" as Address;
const sellToken = "0x0000000000000000000000000000000000000001" as Address;
const buyToken = "0x0000000000000000000000000000000000000002" as Address;
const target = "0x0000000000000000000000000000000000000004" as Address;
const txHash = ("0x" + "a".repeat(64)) as Hash;
const blockHash = ("0x" + "b".repeat(64)) as Hash;
const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;
const addressTopic = (address: Address): Hex => ("0x" + address.slice(2).toLowerCase().padStart(64, "0")) as Hex;
const word = (value: bigint): Hex => ("0x" + value.toString(16).padStart(64, "0")) as Hex;

function fixture(overrides: { status?: "success" | "reverted"; head?: bigint; receiptBlockHash?: Hash; transactionNonce?: number; sellAmount?: bigint } = {}) {
  const status = overrides.status ?? "success";
  const receipt: TradeReceipt = {
    transactionHash: txHash,
    status,
    blockNumber: 100n,
    blockHash: overrides.receiptBlockHash ?? blockHash,
    gasUsed: 100_000n,
    effectiveGasPrice: 30n,
    logs: status === "success" ? [
      { address: sellToken, data: word(overrides.sellAmount ?? 100n), topics: [transferTopic,addressTopic(wallet),addressTopic(target)], logIndex: 1 },
      { address: buyToken, data: word(200n), topics: [transferTopic,addressTopic(target),addressTopic(wallet)], logIndex: 2 },
    ] : [],
  };
  const reader: TradeSettlementReader = {
    getChainId: async () => 137,
    getTransactionReceipt: async () => receipt,
    getTransaction: async () => ({ hash: txHash, from: wallet, to: target, input: "0x12345678" as Hex, value: 0n, nonce: overrides.transactionNonce ?? 5 }),
    getBlockNumber: async () => overrides.head ?? 200n,
    getBlock: async ({ blockNumber }) => ({ number: blockNumber, hash: blockHash, parentHash: blockHash }),
  };
  const request: TradeSettlementRequest = {
    executionId: "trade-1",
    transactionHash: txHash,
    nonce: 5,
    walletAddress: wallet,
    sellToken,
    buyToken,
    reservedSellAmountBaseUnits: "100",
    transactionTarget: target,
    transactionData: "0x12345678",
    transactionValueWei: "0",
    requiredConfirmations: 64,
  };
  return { reader, request, receipt };
}

describe("verifyTradeSettlement", () => {
  it("issues proof only for exact transaction parameters and canonical token transfer logs", async () => {
    const f = fixture();
    const proof = await verifyTradeSettlement(f.reader, f.request);
    expect(isIssuedVerifiedTradeSettlement(proof)).toBe(true);
    expect(proof).toMatchObject({
      executionId: "trade-1",
      chainId: 137,
      nonce: 5,
      status: "confirmed",
      reservedSellAmountBaseUnits: "100",
      actualSellAmountBaseUnits: "100",
      actualBuyAmountBaseUnits: "200",
      gasWei: "3000000",
      blockNumber: "100",
      confirmations: 101,
      requiredConfirmations: 64,
      sellTransferLogIndexes: [1],
      buyTransferLogIndexes: [2],
    });
  });

  it("rejects a transaction with a mismatched nonce", async () => {
    const f = fixture({ transactionNonce: 6 });
    await expect(verifyTradeSettlement(f.reader, f.request)).rejects.toThrow(/nonce/);
  });

  it("rejects a noncanonical receipt block", async () => {
    const f = fixture({ receiptBlockHash: ("0x" + "c".repeat(64)) as Hash });
    await expect(verifyTradeSettlement(f.reader, f.request)).rejects.toThrow(/not canonical/);
  });

  it("rejects insufficient finality", async () => {
    const f = fixture({ head: 120n });
    await expect(verifyTradeSettlement(f.reader, f.request)).rejects.toThrow(/insufficient confirmations/);
  });

  it("rejects a successful receipt that spends more or less than the reserved sell amount", async () => {
    const f = fixture({ sellAmount: 99n });
    await expect(verifyTradeSettlement(f.reader, f.request)).rejects.toThrow(/exact reserved sell amount/);
  });

  it("records gas but never principal for a reverted transaction", async () => {
    const f = fixture({ status: "reverted" });
    const proof = await verifyTradeSettlement(f.reader, f.request);
    expect(proof.status).toBe("reverted");
    expect(proof.actualSellAmountBaseUnits).toBe("0");
    expect(proof.actualBuyAmountBaseUnits).toBe("0");
    expect(proof.gasWei).toBe("3000000");
    expect(isIssuedVerifiedTradeSettlement(proof)).toBe(true);
  });

  it("rejects caller-created proof-shaped objects", () => {
    expect(isIssuedVerifiedTradeSettlement({
      executionId: "trade-1", chainId: 137, transactionHash: txHash, nonce: 5, status: "confirmed",
      reservedSellAmountBaseUnits: "100", actualSellAmountBaseUnits: "100", actualBuyAmountBaseUnits: "200",
      gasWei: "3000000", blockNumber: "100", blockHash,
    })).toBe(false);
  });
});
