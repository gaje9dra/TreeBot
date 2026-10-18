import { decodeEventLog, getAddress, isAddress, parseAbi, type Address, type Hash, type Hex } from "viem";
import type { DepositReceiptLog } from "./deposit-watcher";

const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface WithdrawalReceipt {
  transactionHash: Hash;
  status: "success" | "reverted";
  blockNumber: bigint | null;
  blockHash: Hash | null;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  logs: readonly DepositReceiptLog[];
}

export interface WithdrawalChainReader {
  getChainId(): Promise<number>;
  getTransactionReceipt(args: { hash: Hash }): Promise<WithdrawalReceipt>;
  getTransaction(args: { hash: Hash }): Promise<{ hash: Hash; from: Address; to: Address | null }>;
  getBlockNumber(): Promise<bigint>;
  getBlock(args: { blockNumber: bigint }): Promise<{ number: bigint; hash: Hash; parentHash: Hash }>;
}

export interface VerifiedWithdrawalSettlement {
  readonly withdrawalId: string;
  readonly chainId: 137;
  readonly transactionHash: Hash;
  readonly status: "confirmed" | "reverted";
  readonly sourceAddress: Address;
  readonly tokenAddress: Address;
  readonly recipientAddress: Address;
  readonly amountBaseUnits: string;
  readonly logIndex: number | null;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly confirmations: number;
  readonly requiredConfirmations: number;
  readonly gasWei: string;
}

const issuedSettlements = new WeakSet<object>();

function issueSettlementProof(input: VerifiedWithdrawalSettlement): VerifiedWithdrawalSettlement {
  const proof = Object.freeze({ ...input });
  if (
    !proof.withdrawalId.trim() ||
    proof.chainId !== 137 ||
    !/^0x[0-9a-fA-F]{64}$/.test(proof.transactionHash) ||
    !/^0x[0-9a-fA-F]{40}$/.test(proof.sourceAddress) ||
    !/^0x[0-9a-fA-F]{40}$/.test(proof.tokenAddress) ||
    !/^0x[0-9a-fA-F]{40}$/.test(proof.recipientAddress) ||
    !/^(0|[1-9][0-9]*)$/.test(proof.amountBaseUnits) ||
    !/^[1-9][0-9]*$/.test(proof.blockNumber) ||
    !/^0x[0-9a-fA-F]{64}$/.test(proof.blockHash) ||
    !Number.isInteger(proof.confirmations) || proof.confirmations < 1 ||
    !Number.isInteger(proof.requiredConfirmations) || proof.requiredConfirmations < 1 ||
    proof.confirmations < proof.requiredConfirmations ||
    !/^(0|[1-9][0-9]*)$/.test(proof.gasWei) ||
    (proof.status === "confirmed" && (!Number.isSafeInteger(proof.logIndex) || (proof.logIndex ?? -1) < 0)) ||
    (proof.status === "reverted" && proof.logIndex !== null)
  ) throw new Error("Invalid verified withdrawal settlement proof.");
  issuedSettlements.add(proof);
  return proof;
}

export function isIssuedWithdrawalSettlement(value: unknown): value is VerifiedWithdrawalSettlement {
  return typeof value === "object" && value !== null && issuedSettlements.has(value);
}

/**
 * Verifies a mined Polygon ERC-20 withdrawal receipt against the immutable reservation
 * parameters. This creates a runtime capability; a plain object or TypeScript cast is
 * not accepted by the PostgreSQL settlement method.
 */
export async function verifyWithdrawalSettlement(
  chain: WithdrawalChainReader,
  request: {
    withdrawalId: string;
    transactionHash: string;
    sourceAddress: string;
    tokenAddress: string;
    recipientAddress: string;
    amountBaseUnits: string;
    requiredConfirmations?: number;
  },
): Promise<VerifiedWithdrawalSettlement> {
  if (!request.withdrawalId.trim() || !/^0x[0-9a-fA-F]{64}$/.test(request.transactionHash)) {
    throw new Error("Invalid withdrawal ID or transaction hash.");
  }
  if (![request.sourceAddress, request.tokenAddress, request.recipientAddress].every(isAddress)) {
    throw new Error("Invalid withdrawal source, token, or recipient address.");
  }
  if (!/^[1-9][0-9]*$/.test(request.amountBaseUnits)) throw new Error("Withdrawal amount must be positive base units.");
  const required = request.requiredConfirmations ?? 64;
  if (!Number.isInteger(required) || required < 1 || required > 10_000) throw new Error("Invalid withdrawal confirmation policy.");
  if (await chain.getChainId() !== 137) throw new Error("Withdrawal settlement accepts only Polygon chain ID 137.");

  const transactionHash = request.transactionHash as Hash;
  const source = getAddress(request.sourceAddress);
  const token = getAddress(request.tokenAddress);
  const recipient = getAddress(request.recipientAddress);
  const [receipt, transaction, currentBlock] = await Promise.all([
    chain.getTransactionReceipt({ hash: transactionHash }),
    chain.getTransaction({ hash: transactionHash }),
    chain.getBlockNumber(),
  ]);
  if (receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase() ||
      transaction.hash.toLowerCase() !== transactionHash.toLowerCase()) {
    throw new Error("RPC returned a mismatched withdrawal transaction identity.");
  }
  if (receipt.blockNumber === null || !receipt.blockHash) throw new Error("Withdrawal receipt is not mined.");
  if (getAddress(transaction.from) !== source || transaction.to === null || getAddress(transaction.to) !== token) {
    throw new Error("Withdrawal transaction source or token contract does not match the reservation.");
  }
  const block = await chain.getBlock({ blockNumber: receipt.blockNumber });
  if (block.number !== receipt.blockNumber || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    throw new Error("Withdrawal receipt block is not canonical.");
  }
  const confirmationsBig = currentBlock >= receipt.blockNumber ? currentBlock - receipt.blockNumber + 1n : 0n;
  const confirmations = Number(confirmationsBig > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : confirmationsBig);
  if (confirmations < required) throw new Error("Withdrawal receipt has not reached the configured finality threshold.");
  if (receipt.gasUsed < 0n || receipt.effectiveGasPrice < 0n) throw new Error("Withdrawal receipt gas accounting is invalid.");

  const matches: number[] = [];
  for (const log of receipt.logs) {
    if (log.logIndex === null || !isAddress(log.address) || getAddress(log.address) !== token) continue;
    try {
      const decoded = decodeEventLog({ abi: transferAbi, eventName: "Transfer", data: log.data, topics: [...log.topics] as [Hex, ...Hex[]] });
      const args = decoded.args as { from: Address; to: Address; value: bigint };
      if (getAddress(args.from) === source && getAddress(args.to) === recipient && args.value === BigInt(request.amountBaseUnits)) {
        matches.push(log.logIndex);
      }
    } catch {
      // Unrelated logs do not prove a withdrawal.
    }
  }
  if (receipt.status === "success" && matches.length !== 1) {
    throw new Error("Successful withdrawal receipt must contain exactly one matching token Transfer.");
  }
  if (receipt.status === "reverted" && matches.length !== 0) {
    throw new Error("Reverted withdrawal receipt cannot contain a matching successful Transfer.");
  }

  return issueSettlementProof({
    withdrawalId: request.withdrawalId,
    chainId: 137,
    transactionHash,
    status: receipt.status === "success" ? "confirmed" : "reverted",
    sourceAddress: source,
    tokenAddress: token,
    recipientAddress: recipient,
    amountBaseUnits: receipt.status === "success" ? request.amountBaseUnits : "0",
    logIndex: receipt.status === "success" ? matches[0]! : null,
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
    confirmations,
    requiredConfirmations: required,
    gasWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
  });
}
