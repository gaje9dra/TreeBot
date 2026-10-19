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

