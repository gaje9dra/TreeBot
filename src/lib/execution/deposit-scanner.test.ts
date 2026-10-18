import { describe, expect, it, vi } from "vitest";
import type { Address, Hash, Hex } from "viem";
import {
  PolygonDepositScanner,
  type DepositRangeReader,
  type DepositScannerStore,
  type DepositScanBlock,
  type DepositLogCandidate,
} from "./deposit-scanner";

const vault = "0x0000000000000000000000000000000000000010" as Address;
const token = "0x0000000000000000000000000000000000000020" as Address;
const sender = "0x0000000000000000000000000000000000000030" as Address;
const tx = `0x${"a".repeat(64)}` as Hash;
const blockHash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hash;

function fixture() {
  const blocks = new Map<bigint, DepositScanBlock>();
  for (let i = 0n; i <= 200n; i++) blocks.set(i, { number: i, hash: blockHash(Number(i)), parentHash: blockHash(Number(i - 1n < 0n ? 0n : i - 1n)) });
  const logs: DepositLogCandidate[] = [{
    transactionHash: tx, blockNumber: 100n, blockHash: blockHash(100), logIndex: 3,
    tokenAddress: token, senderAddress: sender, recipientAddress: vault, amount: 123456n,
  }];
  const chain: DepositRangeReader = {
    getChainId: vi.fn(async () => 137),
    getTransactionReceipt: vi.fn(async () => { throw new Error("unused"); }),
    getTransaction: vi.fn(async () => { throw new Error("unused"); }),
    getBlockNumber: vi.fn(async () => 170n),
    getBlock: vi.fn(async ({ blockNumber }) => {
      const block = blocks.get(blockNumber);
      if (!block) throw new Error("unknown block");
      return block;
    }),
    getLogs: vi.fn(async ({ fromBlock, toBlock, address }) =>
      logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock && address.some((a) => a.toLowerCase() === log.tokenAddress.toLowerCase()))),
  };
  let nextBlock = 100n;
  let lastHash: Hash | null = null;
  const observations = new Map<string, { accountId: string; amount: string; blockHash: Hash; status: string }>();
  let credited = new Set<string>();
  const store: DepositScannerStore = {
    getOrCreateCheckpoint: vi.fn(async () => ({ nextBlock, lastScannedBlockHash: lastHash })),
    commitScannedRange: vi.fn(async ({ expectedNextBlock, nextBlock: next, lastScannedBlockHash, observations: found }) => {
      if (expectedNextBlock !== nextBlock) throw new Error("checkpoint compare-and-swap mismatch");
      let inserted = 0, newlyCredited = 0;
      for (const o of found) {
        const key = `${o.chainId}:${o.transactionHash}:${o.logIndex}`;
        if (!observations.has(key)) { observations.set(key, { accountId: o.accountId, amount: o.amountBaseUnits, blockHash: o.blockHash, status: "confirmed" }); inserted++; }
        if (o.confirmations >= o.requiredConfirmations && !credited.has(key)) { credited.add(key); newlyCredited++; }
      }
      nextBlock = next; lastHash = lastScannedBlockHash;
      return { inserted, credited: newlyCredited, reversed: 0 };
    }),
    listActiveDeposits: vi.fn(async () => []),
    reconcileOrphanedDeposits: vi.fn(async () => ({ reversed: 0, exceptions: 0 })),
    rewindCheckpoint: vi.fn(async ({ expectedNextBlock, nextBlock: rewindTo, lastScannedBlockHash }) => {
      if (expectedNextBlock !== nextBlock) throw new Error("checkpoint rewind compare-and-swap mismatch");
      nextBlock = rewindTo;
      lastHash = lastScannedBlockHash;
    }),
    rewindCheckpoint: vi.fn(async ({ expectedNextBlock, nextBlock: rewindTo, lastScannedBlockHash }) => {
      if (expectedNextBlock !== nextBlock) throw new Error("checkpoint rewind compare-and-swap mismatch");
      nextBlock = rewindTo;
      lastHash = lastScannedBlockHash;
    }),
  };
  const scanner = new PolygonDepositScanner(chain, store, {
    watcherKey: "vault-main",
    startBlock: 100n,
    vaultAddress: vault,
    supportedTokenAddresses: [token],
    confirmations: 64,
    maxBlockRange: 100,
    accountForSender: async (address) => address.toLowerCase() === sender.toLowerCase() ? "account-1" : null,
  });
  return { scanner, chain, store, observations, getNext: () => nextBlock, getLastHash: () => lastHash };
}

describe("PolygonDepositScanner", () => {
  it("scans block ranges, checks canonical log blocks, and advances a durable checkpoint", async () => {
    const f = fixture();
    await expect(f.scanner.scanOnce()).resolves.toEqual({
      fromBlock: "100", toBlock: "107", inserted: 0, credited: 0, reversed: 0,
    });
    expect(f.chain.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 100n, toBlock: 107n }));
    expect(f.getNext()).toBe(108n);
    expect(f.getLastHash()).toBe(blockHash(107));
  });

  it("rejects non-Polygon RPC", async () => {
    const f = fixture();
    (f.chain.getChainId as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    await expect(f.scanner.scanOnce()).rejects.toThrow(/chain ID 137/);
    expect(f.store.commitScannedRange).not.toHaveBeenCalled();
  });

  it("does not advance checkpoint when a scanned log has a noncanonical block hash", async () => {
    const f = fixture();
    const logs = f.chain.getLogs as ReturnType<typeof vi.fn>;
    logs.mockResolvedValue([{
      transactionHash: tx, blockNumber: 100n, blockHash: blockHash(99), logIndex: 3,
      tokenAddress: token, senderAddress: sender, recipientAddress: vault, amount: 123456n,
    }]);
    await expect(f.scanner.scanOnce()).rejects.toThrow(/not canonical/);
    expect(f.store.commitScannedRange).not.toHaveBeenCalled();
    expect(f.getNext()).toBe(100n);
  });

  it("does not scan ranges that have not reached finality", async () => {
    const f = fixture();
    (f.chain.getBlockNumber as ReturnType<typeof vi.fn>).mockResolvedValue(100n);
    const result = await f.scanner.scanOnce();
    expect(result.inserted).toBe(0);
    expect(f.chain.getLogs).not.toHaveBeenCalled();
  });
});
