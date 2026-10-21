export interface WithdrawalIncidentInput {
  accountId: string;
  assetAddress: string;
  amountBaseUnits: string;
  withdrawalId: string;
  transactionHash: string | null;
  nonce: number | null;
  reason: string;
}

export interface WithdrawalIncidentEvidence {
  incidentKey: string;
  accountId: string;
  assetAddress: string;
  amountBaseUnits: string;
  transactionHash: string | null;
  nonce: number | null;
  reason: string;
}

export function buildWithdrawalUnknownIncident(input: WithdrawalIncidentInput): WithdrawalIncidentEvidence {
  if (!input.accountId.trim() || !input.withdrawalId.trim() || !input.reason.trim()) {
    throw new Error("Unknown-withdrawal incident requires an account, withdrawal ID and reason.");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.assetAddress)) {
    throw new Error("Unknown-withdrawal incident requires a valid token address.");
  }
  if (!/^[1-9][0-9]*$/.test(input.amountBaseUnits)) {
    throw new Error("Unknown-withdrawal incident amount must be positive base units.");
  }
  if (input.transactionHash !== null && !/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash)) {
    throw new Error("Unknown-withdrawal incident transaction hash is invalid.");
  }
  if (input.nonce !== null && (!Number.isSafeInteger(input.nonce) || input.nonce < 0)) {
    throw new Error("Unknown-withdrawal incident nonce is invalid.");
  }
  const reason = input.reason.slice(0, 500);
  const transactionHash = input.transactionHash?.toLowerCase() ?? null;
  return {
    incidentKey: `withdrawal-submission-unknown:137:${input.withdrawalId}`,
    accountId: input.accountId,
    assetAddress: input.assetAddress.toLowerCase(),
    amountBaseUnits: input.amountBaseUnits,
    transactionHash,
    nonce: input.nonce,
    reason,
  };
}
