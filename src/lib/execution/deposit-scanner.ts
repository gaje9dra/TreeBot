import type { Address, Hash, Hex } from "viem";
import type { DepositChainReader, DepositReceipt } from "./deposit-watcher";

export interface ScannedDepositLog {
  chainId: 137;
  transactionHash: Hash;
  logIndex: number;
  accountId: string;
  assetAddress: Address;
  senderAddress: Address;
  vaultAddress: Address;
  amountBaseUnits: string;
  blockNumber: string;
  blockHash: Hash;
  confirmations: number;
  requiredConfirmations: number;
}

export interface DepositLogCandidate {
  transactionHash: Hash;
  blockNumber: bigint;
  blockHash: Hash;
  logIndex: number;
  tokenAddress: Address;
  senderAddress: Address;
  recipientAddress: Address;
  amount: bigint;
}

export interface DepositScanBlock {
  number: bigint;
  hash: Hash;
  parentHash: Hash;
}

export interface DepositRangeReader extends DepositChainReader {
  getBlock(args: { blockNumber: bigint }): Promise<DepositScanBlock>;
  getLogs(args: {
    fromBlock: bigint;
    toBlock: bigint;
    address: readonly Address[];
    event: "Transfer";
    recipientTopics: readonly Hex[];
  }): Promise<readonly DepositLogCandidate[]>;
}

export type DepositLifecycleStatus =
  | "detected"
  | "provisional"
  | "confirmed"
  | "reversed"
  | "reconciliation_required";

export interface DepositLifecycleRecord extends ScannedDepositLog {
  status: DepositLifecycleStatus;
}

export interface DepositScannerStore {
  /** Create the initial cursor if absent and return the next block to scan. */
  getOrCreateCheckpoint(input: {
    chainId: 137;
    watcherKey: string;
    initialBlock: bigint;
  }): Promise<{ nextBlock: bigint; lastScannedBlockHash: Hash | null }>;
  /** Atomically upsert observations, apply safe credit/reversal transitions, and advance checkpoint. */
  commitScannedRange(input: {
    chainId: 137;
    watcherKey: string;
    expectedNextBlock: bigint;
    nextBlock: bigint;
    lastScannedBlockHash: Hash;
    observations: readonly ScannedDepositLog[];
  }): Promise<{ inserted: number; credited: number; reversed: number }>;
  listActiveDeposits(input: {
    chainId: 137;
    watcherKey: string;
    fromBlock: bigint;
  }): Promise<readonly DepositLifecycleRecord[]>;
  /** Apply auditable compensating entries; never deletes ledger history. */
  reconcileOrphanedDeposits(input: {
    chainId: 137;
    watcherKey: string;
    orphaned: readonly DepositLifecycleRecord[];
    reason: string;
  }): Promise<{ reversed: number; exceptions: number }>;
}

export interface DepositScannerConfig {
  watcherKey: string;
  startBlock: bigint;
  vaultAddress: Address;
  supportedTokenAddresses: readonly Address[];
  confirmations: number;
  maxBlockRange: number;
  accountForSender: (sender: Address) => Promise<string | null>;
}

export class DepositScannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DepositScannerError";
  }
}

/**
 * Durable scanner orchestration. The store must implement each commit under one
 * PostgreSQL transaction and enforce (chain_id, tx_hash, log_index) uniqueness.
 * Credits are not spendable before finality, and a reorg never deletes journal history.
 */
export class PolygonDepositScanner {
  constructor(
    private readonly chain: DepositRangeReader,
    private readonly store: DepositScannerStore,
    private readonly config: DepositScannerConfig,
  ) {
    if (!config.watcherKey.trim()) throw new Error("A durable watcher key is required.");
    if (config.startBlock < 0n) throw new Error("Start block cannot be negative.");
    if (!config.supportedTokenAddresses.length) throw new Error("At least one supported deposit token is required.");
    if (!Number.isInteger(config.confirmations) || config.confirmations < 1 || config.confirmations > 10_000) {
      throw new Error("Confirmations must be an integer between 1 and 10000.");
    }
    if (!Number.isInteger(config.maxBlockRange) || config.maxBlockRange < 1 || config.maxBlockRange > 2_000) {
      throw new Error("Maximum block range must be an integer between 1 and 2000.");
    }
  }

  async scanOnce(): Promise<{ fromBlock: string; toBlock: string; inserted: number; credited: number; reversed: number }> {
    if (await this.chain.getChainId() !== 137) throw new DepositScannerError("Deposit scanner only accepts Polygon chain ID 137.");
    const checkpoint = await this.store.getOrCreateCheckpoint({
      chainId: 137,
      watcherKey: this.config.watcherKey,
      initialBlock: this.config.startBlock,
    });
    const current = await this.chain.getBlockNumber();
    const finalizedHead = current - BigInt(this.config.confirmations) + 1n;
    if (finalizedHead < checkpoint.nextBlock) {
      return { fromBlock: checkpoint.nextBlock.toString(), toBlock: (checkpoint.nextBlock - 1n).toString(), inserted: 0, credited: 0, reversed: 0 };
    }
    const fromBlock = checkpoint.nextBlock;
    const toBlock = finalizedHead < fromBlock + BigInt(this.config.maxBlockRange) - 1n
      ? finalizedHead : fromBlock + BigInt(this.config.maxBlockRange) - 1n;

    // Detect a fork at the previously stored boundary before processing the next range.
    if (checkpoint.lastScannedBlockHash && fromBlock > 0n) {
      const previous = await this.chain.getBlock({ blockNumber: fromBlock - 1n });
      if (previous.hash.toLowerCase() !== checkpoint.lastScannedBlockHash.toLowerCase()) {
        const active = await this.store.listActiveDeposits({ chainId: 137, watcherKey: this.config.watcherKey, fromBlock: fromBlock - 1n });
        const orphaned: DepositLifecycleRecord[] = [];
        for (const record of active) {
          const canonical = await this.chain.getBlock({ blockNumber: BigInt(record.blockNumber) });
          if (canonical.hash.toLowerCase() !== record.blockHash.toLowerCase()) orphaned.push(record);
        }
        await this.store.reconcileOrphanedDeposits({
          chainId: 137,
          watcherKey: this.config.watcherKey,
          orphaned,
          reason: "Canonical block hash changed during deposit scanner checkpoint reconciliation.",
        });
        // Rewind one block after recording reversals. The store must CAS the old cursor,
        // otherwise concurrent workers could silently overwrite one another.
        throw new DepositScannerError("Chain reorganization detected; reversals recorded where possible. Operator/store must rewind checkpoint to canonical boundary before rescanning.");
      }
    }

    const vault = this.config.vaultAddress.toLowerCase();
    const tokens = this.config.supportedTokenAddresses.map((t) => t.toLowerCase());
    const logs = await this.chain.getLogs({
      fromBlock,
      toBlock,
      address: this.config.supportedTokenAddresses,
      event: "Transfer",
      recipientTopics: [this.config.vaultAddress],
    });
    const observations: ScannedDepositLog[] = [];
    for (const log of logs) {
      if (!tokens.includes(log.tokenAddress.toLowerCase())) continue;
      if (log.recipientAddress.toLowerCase() !== vault || log.amount <= 0n) continue;
      const block = await this.chain.getBlock({ blockNumber: log.blockNumber });
      if (block.hash.toLowerCase() !== log.blockHash.toLowerCase()) {
        throw new DepositScannerError("Observed log block hash is not canonical; range checkpoint was not advanced.");
      }
      const accountId = await this.config.accountForSender(log.senderAddress);
      if (!accountId) continue;
      const confirmationsBig = current >= log.blockNumber ? current - log.blockNumber + 1n : 0n;
      const confirmations = Number(confirmationsBig > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : confirmationsBig);
      observations.push({
        chainId: 137,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        accountId,
        assetAddress: log.tokenAddress,
        senderAddress: log.senderAddress,
        vaultAddress: this.config.vaultAddress,
        amountBaseUnits: log.amount.toString(),
        blockNumber: log.blockNumber.toString(),
        blockHash: log.blockHash,
        confirmations,
        requiredConfirmations: this.config.confirmations,
      });
    }
    const last = await this.chain.getBlock({ blockNumber: toBlock });
    const result = await this.store.commitScannedRange({
      chainId: 137,
      watcherKey: this.config.watcherKey,
      expectedNextBlock: fromBlock,
      nextBlock: toBlock + 1n,
      lastScannedBlockHash: last.hash,
      observations,
    });
    return { fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), ...result };
  }
}

/** Adapter used by a configured RPC implementation to normalize receipt status. */
export function assertSuccessfulDepositReceipt(receipt: DepositReceipt): void {
  if (receipt.status !== "success" || receipt.blockNumber === null) {
    throw new DepositScannerError("Deposit candidate has no successful mined receipt.");
  }
}
