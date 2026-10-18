import { isAddress, getAddress, type Address } from "viem";

export interface ExecutionAuthorization {
  id: string;
  owner: string;
  chainId: number;
  allowedTokens: string[];
  allowedTargets: string[];
  maximumSellAmount: string;
  maximumDailySellAmount?: string;
  dailySellAmount?: string;
  expiresAt: number;
  revokedAt: number | null;
  authorizedBy: "owner_wallet" | "audited_smart_account";
  emergencyStopped?: boolean;
}
export interface ExecutionIntent {
  chainId: number; owner: string; sellToken: string; buyToken: string; sellAmount: string; transactionTarget: string; now?: number;
}
export type AuthorizationResult = { allowed: true; owner: Address } | { allowed: false; reason: string };

export function authorizeExecution(authorization: ExecutionAuthorization, intent: ExecutionIntent): AuthorizationResult {
  if (!isAddress(authorization.owner) || !isAddress(intent.owner)) return { allowed: false, reason: "Invalid owner address." };
  const owner = getAddress(authorization.owner);
  if (owner !== getAddress(intent.owner)) return { allowed: false, reason: "Intent owner does not match authorization owner." };
  if (authorization.chainId !== 137 || intent.chainId !== 137) return { allowed: false, reason: "Only Polygon PoS chain ID 137 is authorized." };
  if (authorization.revokedAt !== null) return { allowed: false, reason: "Authorization has been revoked." };
  if (authorization.emergencyStopped === true) return { allowed: false, reason: "Emergency stop is active." };
  const now = intent.now ?? Date.now();
  if (!Number.isFinite(authorization.expiresAt) || authorization.expiresAt <= now) return { allowed: false, reason: "Authorization has expired." };
  if (!/^[1-9][0-9]*$/.test(authorization.maximumSellAmount) || !/^[1-9][0-9]*$/.test(intent.sellAmount)) return { allowed: false, reason: "Amounts must be positive base-unit integers." };
  const amount = BigInt(intent.sellAmount);
  if (amount > BigInt(authorization.maximumSellAmount)) return { allowed: false, reason: "Sell amount exceeds authorized per-trade limit." };
  if (authorization.maximumDailySellAmount !== undefined) {
    if (!/^[1-9][0-9]*$/.test(authorization.maximumDailySellAmount) || !/^(0|[1-9][0-9]*)$/.test(authorization.dailySellAmount ?? "0")) {
      return { allowed: false, reason: "Daily spending limits are invalid." };
    }
    if (BigInt(authorization.dailySellAmount ?? "0") + amount > BigInt(authorization.maximumDailySellAmount)) return { allowed: false, reason: "Aggregate daily spending limit exceeded." };
  }
  if (![intent.sellToken,intent.buyToken,intent.transactionTarget,...authorization.allowedTokens,...authorization.allowedTargets].every((address) => isAddress(address))) return { allowed: false, reason: "Authorization or intent contains an invalid address." };
  const tokens = new Set(authorization.allowedTokens.map((token) => getAddress(token).toLowerCase()));
  if (!tokens.has(getAddress(intent.sellToken).toLowerCase()) || !tokens.has(getAddress(intent.buyToken).toLowerCase())) return { allowed: false, reason: "Token is outside the authorization scope." };
  const targets = new Set(authorization.allowedTargets.map((target) => getAddress(target).toLowerCase()));
  if (!targets.has(getAddress(intent.transactionTarget).toLowerCase())) return { allowed: false, reason: "Transaction target is outside the authorization scope." };
  if (authorization.authorizedBy !== "owner_wallet" && authorization.authorizedBy !== "audited_smart_account") return { allowed: false, reason: "Unsupported authorization mechanism." };
  return { allowed: true, owner };
}

/** No generic backend signer. Mainnet broadcast requires an independently audited on-chain grant. */
export function assertLiveExecutionUnavailable(): never {
  throw new Error("Live execution is hard-disabled: no audited autonomous signing/custody implementation is deployed.");
}
