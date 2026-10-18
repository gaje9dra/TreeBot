export const TRANSACTION_STATUSES = [
  "prepared", "awaiting_signature", "signed", "submitted", "pending",
  "confirmed", "reverted", "replaced", "failed", "unknown",
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

const transitions: Record<TransactionStatus, readonly TransactionStatus[]> = {
  prepared: ["awaiting_signature", "failed"],
  awaiting_signature: ["signed", "failed"],
  signed: ["submitted", "failed", "unknown"],
  submitted: ["pending", "confirmed", "reverted", "replaced", "unknown", "failed"],
  pending: ["confirmed", "reverted", "replaced", "unknown"],
  unknown: ["pending", "confirmed", "reverted", "replaced", "failed"],
  replaced: ["pending", "confirmed", "reverted", "unknown"],
  confirmed: [],
  reverted: [],
  failed: [],
};

export interface TransactionLifecycleRecord {
  id: string;
  idempotencyKey: string;
  chainId: number;
  walletAddress: string;
  sellToken: string;
  buyToken: string;
  side: "buy" | "sell";
  sellAmount: string;
  quote: Record<string, unknown>;
  authorizationId: string;
  riskChecks: Record<string, unknown>;
  preparedTransaction: Record<string, unknown>;
  status: TransactionStatus;
  txHash: string | null;
  nonce: number | null;
  confirmationBlock: string | null;
  actualSellAmount: string | null;
  actualBuyAmount: string | null;
  actualGasWei: string | null;
  executionPrice: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export function canTransitionTransaction(from: TransactionStatus, to: TransactionStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTransactionTransition(from: TransactionStatus, to: TransactionStatus): void {
  if (!canTransitionTransaction(from, to)) throw new Error(`Invalid transaction status transition: ${from} -> ${to}`);
}

/** A send timeout is indeterminate. Never treat it as failure without chain reconciliation. */
export function classifySubmissionError(error: unknown): { status: "unknown"; retryAllowed: false; message: string } {
  const message = error instanceof Error ? error.message : "Unknown RPC submission error.";
  return { status: "unknown", retryAllowed: false, message: message.slice(0, 500) };
}
