import type { Address, Hash, Hex } from "viem";
import type { DepositChainReader, DepositReceipt } from "./deposit-watcher";
import type { VerifiedDepositProof } from "./deposit-proof";

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
  /** Present only when the scanner had an explicit token-decimals policy for this token. */
  proof?: VerifiedDepositProof;
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
  getOrCreateCheckpoint(input: {
    chainId: 137;
    watcherKey: string;
    initialBlock: bigint;
  }): Promise<{ nextBlock: bigint; lastScannedBlockHash: Hash | null }>;
  /** One serializable PostgreSQL transaction; compare-and-swap nextBlock before all writes. */
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
  /** Atomically records orphan handling and rewinds the checkpoint in one database transaction. */
  recoverReorg(input: {
    chainId: 137;
    watcherKey: string;
    expectedNextBlock: bigint;
    nextBlock: bigint;
    lastScannedBlockHash: Hash | null;
    orphaned: readonly DepositLifecycleRecord[];
    reason: string;
  }): Promise<{ reversed: number; exceptions: number }>;
}


const issuedProofs = new WeakSet<object>();

function issueVerifiedDepositProof(input: VerifiedDepositProof): VerifiedDepositProof {
  const proof = Object.freeze({ ...input });
  if (
    proof.chainId !== 137 ||
    !/^0x[0-9a-fA-F]{64}$/.test(proof.transactionHash) ||
    !/^0x[0-9a-fA-F]{64}$/.test(proof.blockHash) ||
    !/^0x[0-9a-fA-F]{64}$/.test(proof.receiptTransactionHash) ||
    proof.receiptStatus !== "success" ||
    !/^(0|[1-9][0-9]*)$/.test(proof.receiptBlockNumber) ||
    !/^0x[0-9a-fA-F]{64}$/.test(proof.receiptBlockHash) ||
    proof.receiptTransactionHash.toLowerCase() !== proof.transactionHash.toLowerCase() ||
    proof.receiptBlockNumber !== proof.blockNumber ||
    proof.receiptBlockHash.toLowerCase() !== proof.blockHash.toLowerCase() ||
    !Number.isSafeInteger(proof.logIndex) || proof.logIndex < 0 ||
    !proof.accountId.trim() ||
    !/^0x[0-9a-fA-F]{40}$/.test(proof.tokenAddress) ||
    !/^0x[0-9a-fA-F]{40}$/.test(proof.senderAddress) ||
    !/^0x[0-9a-fA-F]{40}$/.test(proof.recipientAddress) ||
    !/^[1-9][0-9]*$/.test(proof.amountBaseUnits) ||
    !/^(0|[1-9][0-9]*)$/.test(proof.blockNumber) ||
    !Number.isInteger(proof.tokenDecimals) || proof.tokenDecimals < 0 || proof.tokenDecimals > 36
  ) throw new Error("Invalid verified deposit proof payload.");
  issuedProofs.add(proof);
  return proof;
}

export function isIssuedVerifiedDepositProof(value: unknown): value is VerifiedDepositProof {
  return typeof value === "object" && value !== null && issuedProofs.has(value);
}

const TRANSFER_EVENT_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface DepositScannerConfig {
  watcherKey: string;
  startBlock: bigint;
  vaultAddress: Address;
  supportedTokenAddresses: readonly Address[];
  /** Must be explicitly enabled; production also requires TREEBOT_DEPOSITS_ENABLED=true. */
  creditingEnabled?: boolean;
  /** Explicit on-chain decimals for each allowlisted token. */
  tokenDecimalsByAddress?: Readonly<Record<string, number>>;
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
 * Durable scanning orchestration. A production store must use PostgreSQL transactions,
 * CAS checkpoints, unique event keys, and idempotent ledger entries. This class alone
 * does not enable spendable credits.
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
    for (const [token, decimals] of Object.entries(config.tokenDecimalsByAddress ?? {})) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(token) || !config.supportedTokenAddresses.some((allowed) => allowed.toLowerCase() === token.toLowerCase()) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
        throw new Error("Token decimals policy must contain valid decimals for allowlisted token addresses only.");
      }
    }
    if (config.creditingEnabled && !config.supportedTokenAddresses.every((token) => Object.keys(config.tokenDecimalsByAddress ?? {}).some((configured) => configured.toLowerCase() === token.toLowerCase()))) {
      throw new Error("Deposit crediting requires explicit token decimals for every allowlisted token.");
    }
    if (!Number.isInteger(config.confirmations) || config.confirmations < 1 || config.confirmations > 10_000) {
      throw new Error("Confirmations must be an integer between 1 and 10000.");
    }
    if (!Number.isInteger(config.maxBlockRange) || config.maxBlockRange < 1 || config.maxBlockRange > 2_000) {
      throw new Error("Maximum block range must be an integer between 1 and 2000.");
    }
  }

  async scanOnce(): Promise<{ fromBlock: string; toBlock: string; inserted: number; credited: number; reversed: number }> {
    if (!this.config.creditingEnabled) throw new DepositScannerError("Deposit scanner is disabled until explicitly activated.");
    if (process.env.NODE_ENV !== "test" && process.env.TREEBOT_DEPOSITS_ENABLED !== "true") {
      throw new DepositScannerError("Production deposit scanning requires TREEBOT_DEPOSITS_ENABLED=true after release prerequisites are approved.");
    }
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

    if (checkpoint.lastScannedBlockHash && fromBlock > 0n) {
      const previous = await this.chain.getBlock({ blockNumber: fromBlock - 1n });
      if (previous.hash.toLowerCase() !== checkpoint.lastScannedBlockHash.toLowerCase()) {
        const active = await this.store.listActiveDeposits({ chainId: 137, watcherKey: this.config.watcherKey, fromBlock: fromBlock - 1n });
        const orphaned: DepositLifecycleRecord[] = [];
        for (const record of active) {
          const canonical = await this.chain.getBlock({ blockNumber: BigInt(record.blockNumber) });
          if (canonical.hash.toLowerCase() !== record.blockHash.toLowerCase()) orphaned.push(record);
        }
        const rewindTo = orphaned.length
          ? orphaned.reduce((n, record) => {
              const block = BigInt(record.blockNumber);
              return block < n ? block : n;
            }, fromBlock - 1n)
          : fromBlock - 1n;
        const newPriorBlock = rewindTo > 0n ? await this.chain.getBlock({ blockNumber: rewindTo - 1n }) : null;
        await this.store.recoverReorg({
          chainId: 137,
          watcherKey: this.config.watcherKey,
          expectedNextBlock: fromBlock,
          nextBlock: rewindTo,
          lastScannedBlockHash: newPriorBlock?.hash ?? null,
          orphaned,
          reason: "Canonical block hash changed during deposit scanner checkpoint reconciliation.",
        });
        throw new DepositScannerError("Chain reorganization reconciled; scanner checkpoint rewound. Retry scanning from the canonical checkpoint.");
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
      if (log.blockNumber < fromBlock || log.blockNumber > toBlock) {
        throw new DepositScannerError("RPC returned a log outside the requested block range.");
      }
      const block = await this.chain.getBlock({ blockNumber: log.blockNumber });
      if (block.hash.toLowerCase() !== log.blockHash.toLowerCase()) {
        throw new DepositScannerError("Observed log block hash is not canonical; range checkpoint was not advanced.");
      }
      // Check both the event block and current head-derived finality before a credit can be considered.
      const receipt = await this.chain.getTransactionReceipt({ hash: log.transactionHash });
      if (
        receipt.transactionHash.toLowerCase() !== log.transactionHash.toLowerCase() ||
        receipt.status !== "success" ||
        receipt.blockNumber !== log.blockNumber ||
        !receipt.blockHash ||
        receipt.blockHash.toLowerCase() !== log.blockHash.toLowerCase()
      ) {
        throw new DepositScannerError("Deposit candidate receipt identity, status, block number, or block hash does not match the event.");
      }
      const receiptLog = receipt.logs.find((candidate) => candidate.logIndex === log.logIndex);
      const expectedSenderTopic = `0x${log.senderAddress.slice(2).toLowerCase().padStart(64, "0")}`;
      const expectedRecipientTopic = `0x${log.recipientAddress.slice(2).toLowerCase().padStart(64, "0")}`;
      const expectedAmountData = `0x${log.amount.toString(16).padStart(64, "0")}`;
      if (
        !receiptLog ||
        receiptLog.address.toLowerCase() !== log.tokenAddress.toLowerCase() ||
        receiptLog.topics.length !== 3 ||
        receiptLog.topics[0]?.toLowerCase() !== TRANSFER_EVENT_TOPIC ||
        receiptLog.topics[1]?.toLowerCase() !== expectedSenderTopic ||
        receiptLog.topics[2]?.toLowerCase() !== expectedRecipientTopic ||
        receiptLog.data.toLowerCase() !== expectedAmountData
      ) {
        throw new DepositScannerError("Deposit candidate does not match the exact Transfer log at its receipt log index.");
      }
      const accountId = await this.config.accountForSender(log.senderAddress);
      if (!accountId) continue;
      const confirmationsBig = current >= log.blockNumber ? current - log.blockNumber + 1n : 0n;
      const confirmations = Number(confirmationsBig > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : confirmationsBig);
      const tokenDecimals = Object.entries(this.config.tokenDecimalsByAddress ?? {}).find(([address]) => address.toLowerCase() === log.tokenAddress.toLowerCase())?.[1];
      const proof = tokenDecimals === undefined ? undefined : issueVerifiedDepositProof({
        chainId: 137,
        transactionHash: log.transactionHash,
        receiptTransactionHash: receipt.transactionHash,
        receiptStatus: "success",
        receiptBlockNumber: receipt.blockNumber!.toString(),
        receiptBlockHash: receipt.blockHash!,
        logIndex: log.logIndex,
        accountId,
        tokenAddress: log.tokenAddress,
        senderAddress: log.senderAddress,
        recipientAddress: this.config.vaultAddress,
        amountBaseUnits: log.amount.toString(),
        blockNumber: log.blockNumber.toString(),
        blockHash: log.blockHash,
        tokenDecimals,
      });
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
        ...(proof ? { proof } : {}),
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

export function assertSuccessfulDepositReceipt(receipt: DepositReceipt): void {
  if (receipt.status !== "success" || receipt.blockNumber === null) {
    throw new DepositScannerError("Deposit candidate has no successful mined receipt.");
  }
}
