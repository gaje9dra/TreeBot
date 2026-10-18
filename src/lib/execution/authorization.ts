import { isAddress, getAddress, type Address } from "viem";

export interface ExecutionAuthorization {
  id: string;
  owner: string;
  chainId: number;
  allowedTokens: string[];
  allowedTargets: string[];
  maximumSellAmount: string;
  expiresAt: number;
  revokedAt: number | null;
  authorizedBy: "owner_wallet" | "audited_smart_account";
}

export interface ExecutionIntent {
  chainId: number;
  owner: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  transactionTarget: string;
  now?: number;
}

export type AuthorizationResult = { allowed: true; owner: Address } | { allowed: false; reason: string };

/**
 * Pure authorization boundary. This does not sign or submit transactions. A future
 * executor must load current authorization from durable trusted storage and call this
 * function immediately before simulation/submission.
 */
export function authorizeExecution(
  authorization: ExecutionAuthorization,
  intent: ExecutionIntent,
): AuthorizationResult {
  if (!isAddress(authorization.owner) || !isAddress(intent.owner)) return { allowed: false, reason: "Invalid owner address." };
  const owner = getAddress(authorization.owner);
  if (owner !== getAddress(intent.owner)) return { allowed: false, reason: "Intent owner does not match authorization owner." };
  if (authorization.chainId !== 137 || intent.chainId !== 137) return { allowed: false, reason: "Only Polygon PoS chain ID 137 is authorized." };
  if (authorization.revokedAt !== null) return { allowed: false, reason: "Authorization has been revoked." };
  const now = intent.now ?? Date.now();
  if (!Number.isFinite(authorization.expiresAt) || authorization.expiresAt <= now) return { allowed: false, reason: "Authorization has expired." };
  if (!/^[1-9][0-9]*$/.test(authorization.maximumSellAmount) || !/^[1-9][0-9]*$/.test(intent.sellAmount)) {
    return { allowed: false, reason: "Amounts must be positive base-unit integers." };
  }
  if (BigInt(intent.sellAmount) > BigInt(authorization.maximumSellAmount)) return { allowed: false, reason: "Sell amount exceeds authorized limit." };
  if (![intent.sellToken, intent.buyToken, intent.transactionTarget, ...authorization.allowedTokens, ...authorization.allowedTargets].every(isAddress)) {
    return { allowed: false, reason: "Authorization or intent contains an invalid address." };
  }
  const tokens = new Set(authorization.allowedTokens.map((token) => getAddress(token).toLowerCase()));
  if (!tokens.has(getAddress(intent.sellToken).toLowerCase()) || !tokens.has(getAddress(intent.buyToken).toLowerCase())) {
    return { allowed: false, reason: "Token is outside the authorization scope." };
  }
  const targets = new Set(authorization.allowedTargets.map((target) => getAddress(target).toLowerCase()));
  if (!targets.has(getAddress(intent.transactionTarget).toLowerCase())) return { allowed: false, reason: "Transaction target is outside the authorization scope." };
  if (authorization.authorizedBy !== "owner_wallet" && authorization.authorizedBy !== "audited_smart_account") {
    return { allowed: false, reason: "Unsupported authorization mechanism." };
  }
  return { allowed: true, owner };
}

/** Mainnet signing, deposits and custody are intentionally unavailable in this stage. */
export function assertLiveExecutionUnavailable(): never {
  throw new Error("Live execution is hard-disabled: no audited autonomous signing/custody implementation is deployed.");
}
