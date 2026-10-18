import type { Address, Hash } from "viem";

/**
 * Runtime capability for an observation verified by PolygonDepositScanner.
 * WeakSet membership is process-local and cannot be recreated by JSON/client input
 * or by merely asserting a TypeScript type. Only the scanner should issue proofs.
 */
export interface VerifiedDepositProof {
  readonly chainId: 137;
  readonly transactionHash: Hash;
  readonly receiptTransactionHash: Hash;
  readonly receiptStatus: "success";
  readonly receiptBlockNumber: string;
  readonly receiptBlockHash: Hash;
  readonly logIndex: number;
  readonly accountId: string;
  readonly tokenAddress: Address;
  readonly senderAddress: Address;
  readonly recipientAddress: Address;
  readonly amountBaseUnits: string;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly tokenDecimals: number;
}

const issuedProofs = new WeakSet<object>();

export function issueVerifiedDepositProof(input: VerifiedDepositProof): VerifiedDepositProof {
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
