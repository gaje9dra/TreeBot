import { createPublicClient, formatEther, http, isAddress, type Address, type Chain } from "viem";
import { polygon } from "viem/chains";

export const POLYGON_CHAIN_ID = 137;
export const MINIMUM_STARTING_CAPITAL_POL = 150;
export const polygonChain: Chain = polygon;

export function validateConnectedChain(chainId: number | undefined): { valid: boolean; message: string } {
  if (chainId === POLYGON_CHAIN_ID) return { valid: true, message: "Connected to Polygon PoS mainnet." };
  return { valid: false, message: `Switch your wallet to Polygon PoS (chain ID ${POLYGON_CHAIN_ID}).` };
}

export function validateWalletAddress(address: string | undefined): address is Address {
  return typeof address === "string" && isAddress(address);
}

export function assessNativeCapital(balanceWei: bigint, gasReservePol = 2) {
  if (balanceWei < 0n || !Number.isFinite(gasReservePol) || gasReservePol < 0) throw new Error("Invalid balance or gas reserve.");
  const balancePol = Number(formatEther(balanceWei));
  const availableAfterGasReservePol = Math.max(0, balancePol - gasReservePol);
  const eligible = balancePol >= MINIMUM_STARTING_CAPITAL_POL + gasReservePol;
  return {
    walletBalancePol: balancePol,
    gasReservePol,
    availableAfterGasReservePol,
    minimumCapitalPol: MINIMUM_STARTING_CAPITAL_POL,
    shortfallPol: Math.max(0, MINIMUM_STARTING_CAPITAL_POL + gasReservePol - balancePol),
    eligible
  };
}

export function createPolygonReadClient(rpcUrl = process.env.POLYGON_RPC_URL) {
  if (!rpcUrl) throw new Error("POLYGON_RPC_URL is required for on-chain reads.");
  const url = new URL(rpcUrl);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new Error("Polygon RPC endpoint must use HTTPS outside local development.");
  return createPublicClient({ chain: polygon, transport: http(url.toString(), { timeout: 10_000, retryCount: 1 }) });
}
