import {
  createPublicClient, http, isAddress, getAddress, parseAbi,
  type Address, type Hash, type Hex, type PublicClient,
} from "viem";
import { polygon } from "viem/chains";
import type { ValidatedSwapQuote } from "./zero-ex";

export const ERC20_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export interface TransactionSimulation {
  chainId: 137;
  from: Address;
  to: Address;
  data: Hex;
  value: bigint;
  gasEstimate: bigint;
}
export interface ReceiptSettlement {
  hash: Hash;
  status: "confirmed" | "reverted";
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  gasCostWei: bigint;
}
export class ChainValidationError extends Error {
  constructor(message: string) { super(message); this.name = "ChainValidationError"; }
}

/** Read/simulation client. It deliberately has no signer or sendTransaction method. */
export class PolygonExecutionReadClient {
  readonly publicClient: PublicClient;

  constructor(rpcUrl: string, client?: PublicClient) {
    let url: URL;
    try { url = new URL(rpcUrl); } catch { throw new Error("POLYGON_RPC_URL must be a valid URL."); }
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new Error("POLYGON_RPC_URL must use HTTPS outside local development.");
    }
    this.publicClient = client ?? createPublicClient({ chain: polygon, transport: http(url.toString(), { timeout: 10_000 }) }) as PublicClient;
  }

  async assertPolygon(): Promise<void> {
    const chainId = await this.publicClient.getChainId();
    if (chainId !== 137) throw new ChainValidationError(`Expected Polygon chain ID 137, received ${chainId}.`);
  }

  async simulateExactSwap(quote: ValidatedSwapQuote, from: string): Promise<TransactionSimulation> {
    await this.assertPolygon();
    if (!isAddress(from)) throw new ChainValidationError("Invalid sender address.");
    const sender = getAddress(from);
    if (quote.chainId !== 137 || quote.taker !== sender) throw new ChainValidationError("Quote chain/taker does not match the execution wallet.");
    const { to, data, value } = quote.transaction;
    // Simulate precisely the unmodified calldata/target/value. Simulation is not an authorization grant.
    await this.publicClient.call({ account: sender, to, data, value });
    const gasEstimate = await this.publicClient.estimateGas({ account: sender, to, data, value });
    return { chainId: 137, from: sender, to, data, value, gasEstimate };
  }

  async erc20Allowance(token: string, owner: string, spender: string): Promise<bigint> {
    await this.assertPolygon();
    if (![token, owner, spender].every(isAddress)) throw new ChainValidationError("Invalid ERC-20 allowance address.");
    return this.publicClient.readContract({
      address: getAddress(token), abi: ERC20_ABI, functionName: "allowance",
      args: [getAddress(owner), getAddress(spender)],
    });
  }

  async waitForSettlement(hash: Hash, confirmations = 3, timeout = 120_000): Promise<ReceiptSettlement> {
    await this.assertPolygon();
    if (!Number.isInteger(confirmations) || confirmations < 1 || confirmations > 256) throw new Error("Confirmation count must be 1 to 256.");
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash, confirmations, timeout, pollingInterval: 2_000, retryCount: 0,
    });
    const effectiveGasPrice = receipt.effectiveGasPrice;
    return { hash: receipt.transactionHash, status: receipt.status === "success" ? "confirmed" : "reverted",
      blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, effectiveGasPrice, gasCostWei: receipt.gasUsed * effectiveGasPrice };
  }

  async reconcileHash(hash: Hash): Promise<{ found: false } | { found: true; settlement: ReceiptSettlement }> {
    await this.assertPolygon();
    try {
      const receipt = await this.publicClient.getTransactionReceipt({ hash });
      const effectiveGasPrice = receipt.effectiveGasPrice;
      return { found: true, settlement: { hash: receipt.transactionHash,
        status: receipt.status === "success" ? "confirmed" : "reverted", blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed, effectiveGasPrice, gasCostWei: receipt.gasUsed * effectiveGasPrice } };
    } catch {
      // No receipt does not prove no broadcast. Caller must reconcile nonce and tx visibility. Never resubmit here.
      return { found: false };
    }
  }
}
