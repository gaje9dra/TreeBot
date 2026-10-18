import type { TradingMode } from "./types";

export interface ReadinessInput {
  connected: boolean;
  chainId: number | undefined;
  eligibleCapital: boolean;
  marketDataHealthy: boolean;
  rpcHealthy: boolean;
  emergencyStop: boolean;
  mode: TradingMode;
  explicitOwnerAuthorization: boolean;
}

export function tradingReadiness(input: ReadinessInput): { canTrade: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (!input.connected) blockers.push("Connect a wallet.");
  if (input.chainId !== 137) blockers.push("Wallet must be on Polygon PoS (chain ID 137).");
  if (!input.eligibleCapital) blockers.push("At least 150 POL plus the configured gas reserve is required.");
  if (!input.marketDataHealthy) blockers.push("Market data is not healthy or fresh.");
  if (!input.rpcHealthy) blockers.push("Polygon RPC health check has not passed.");
  if (input.emergencyStop) blockers.push("Emergency stop is active.");
  if (input.mode === "live") blockers.push("Live execution is not implemented and remains hard-disabled.");
  if (!input.explicitOwnerAuthorization) blockers.push("Explicit owner authorization is required.");
  return { canTrade: blockers.length === 0, blockers };
}
