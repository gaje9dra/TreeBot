import { z } from "zod";
import { isAddress, type Address, getAddress } from "viem";

export const POLYGON_CHAIN_ID = 137;
export const ZEROX_API_BASE = "https://api.0x.org";
export const DEFAULT_QUOTE_MAX_AGE_MS = 15_000;

const addressSchema = z.string().refine((value) => isAddress(value), "Invalid EVM address").transform((value) => getAddress(value));
const hexSchema = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/, "Expected even-length hex data");

export interface AllowedToken {
  address: Address;
  symbol: string;
  decimals: number;
}

export interface ZeroExConfig {
  apiKey: string;
  allowedTokens: readonly AllowedToken[];
  allowedTransactionTargets: readonly Address[];
  maximumSlippageBps: number;
  maximumPriceImpactBps: number;
  maximumQuoteAgeMs?: number;
  now?: () => number;
  fetcher?: typeof fetch;
}

export interface QuoteRequest {
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  taker: string;
  chainId: number;
  slippageBps: number;
}

export interface ValidatedSwapQuote {
  provider: "0x";
  chainId: 137;
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  buyAmount: bigint;
  minBuyAmount: bigint;
  taker: Address;
  allowanceTarget: Address | null;
  transaction: {
    to: Address;
    data: `0x${string}`;
    value: bigint;
    gas?: bigint;
    gasPrice?: bigint;
  };
  liquiditySources: string[];
  estimatedGas: bigint | null;
  quoteTimestamp: number;
  priceImpactBps: number | null;
  slippageBps: number;
  rawFeeAmounts: string[];
}

export class QuoteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteValidationError";
  }
}

const positiveIntegerString = z.string().regex(/^[1-9][0-9]*$/);
const nonNegativeIntegerString = z.string().regex(/^(0|[1-9][0-9]*)$/);

function integer(value: unknown, label: string, allowZero = false): bigint {
  const parsed = (allowZero ? nonNegativeIntegerString : positiveIntegerString).safeParse(String(value));
  if (!parsed.success) throw new QuoteValidationError(`Invalid ${label}.`);
  return BigInt(parsed.data);
}

function optionalAddress(value: unknown, label: string): Address | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = addressSchema.safeParse(value);
  if (!parsed.success) throw new QuoteValidationError(`Invalid ${label} address.`);
  return parsed.data;
}

function decimalAmount(value: bigint, decimals: number): number {
  // Convert using string arithmetic to prevent the amount's magnitude from overflowing first.
  const text = value.toString().padStart(decimals + 1, "0");
  const whole = text.slice(0, text.length - decimals) || "0";
  const fraction = decimals ? text.slice(-decimals).replace(/0+$/, "") : "";
  const result = Number(fraction ? `${whole}.${fraction}` : whole);
  if (!Number.isFinite(result)) throw new QuoteValidationError("Quote amount is outside safe numeric range.");
  return result;
}

function parseSlippageBps(value: unknown): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 10_000) throw new QuoteValidationError("Invalid slippageBps.");
  return number;
}

/**
 * 0x v2 firm-quote adapter for Polygon. All returned calldata remains untrusted until
 * a separate execution verifier and chain simulation approve it.
 */
export class ZeroExPolygonQuoteAdapter {
  constructor(private readonly config: ZeroExConfig) {
    if (!config.apiKey.trim()) throw new Error("A server-side 0x API key is required.");
    if (!Number.isInteger(config.maximumSlippageBps) || config.maximumSlippageBps < 1 || config.maximumSlippageBps > 5000) {
      throw new Error("maximumSlippageBps must be an integer from 1 to 5000.");
    }
    if (!Number.isFinite(config.maximumPriceImpactBps) || config.maximumPriceImpactBps < 0 || config.maximumPriceImpactBps > 10_000) {
      throw new Error("maximumPriceImpactBps must be between 0 and 10000.");
    }
    if (!config.allowedTokens.length || !config.allowedTransactionTargets.length) {
      throw new Error("Token and transaction-target allowlists must be non-empty.");
    }
    for (const token of config.allowedTokens) {
      if (!isAddress(token.address) || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36 || !token.symbol.trim()) {
        throw new Error("Invalid allowed-token configuration.");
      }
    }
  }

  async getFirmQuote(request: QuoteRequest): Promise<ValidatedSwapQuote> {
    if (request.chainId !== POLYGON_CHAIN_ID) throw new QuoteValidationError("Only Polygon PoS (chain ID 137) is allowed.");
    const sellToken = optionalAddress(request.sellToken, "sell token");
    const buyToken = optionalAddress(request.buyToken, "buy token");
    const taker = optionalAddress(request.taker, "taker");
    if (!sellToken || !buyToken || !taker || sellToken === buyToken) throw new QuoteValidationError("Invalid or identical token pair.");
    const tokenMap = new Map(this.config.allowedTokens.map((token) => [token.address.toLowerCase(), token]));
    if (!tokenMap.has(sellToken.toLowerCase()) || !tokenMap.has(buyToken.toLowerCase())) {
      throw new QuoteValidationError("One or both tokens are not on the explicit token allowlist.");
    }
    const sellAmount = integer(request.sellAmount, "sellAmount");
    if (!Number.isInteger(request.slippageBps) || request.slippageBps < 0 || request.slippageBps > this.config.maximumSlippageBps) {
      throw new QuoteValidationError("Requested slippage exceeds configured ceiling.");
    }
    const fetcher = this.config.fetcher ?? fetch;
    const url = new URL("/swap/allowance-holder/quote", ZEROX_API_BASE);
    url.search = new URLSearchParams({
      chainId: String(POLYGON_CHAIN_ID),
      sellToken,
      buyToken,
      sellAmount: sellAmount.toString(),
      taker,
      slippageBps: String(request.slippageBps),
    }).toString();

    const response = await fetcher(url, {
      method: "GET",
      headers: { "0x-api-key": this.config.apiKey, "0x-version": "v2", accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!response.ok) throw new QuoteValidationError(`0x quote request failed with HTTP ${response.status}.`);
    const payload: unknown = await response.json();
    return this.validatePayload(payload, { sellToken, buyToken, taker, sellAmount, slippageBps: request.slippageBps });
  }

  private validatePayload(
    payload: unknown,
    expected: { sellToken: Address; buyToken: Address; taker: Address; sellAmount: bigint; slippageBps: number },
  ): ValidatedSwapQuote {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new QuoteValidationError("Quote response must be an object.");
    const q = payload as Record<string, unknown>;
    if (Number(q.chainId) !== POLYGON_CHAIN_ID) throw new QuoteValidationError("Quote response chain is not Polygon PoS.");
    const responseSell = optionalAddress(q.sellToken, "response sell token");
    const responseBuy = optionalAddress(q.buyToken, "response buy token");
    const responseTaker = optionalAddress(q.taker, "response taker");
    if (responseSell !== expected.sellToken || responseBuy !== expected.buyToken || responseTaker !== expected.taker) {
      throw new QuoteValidationError("Quote token pair or taker does not match the request.");
    }
    const sellAmount = integer(q.sellAmount, "response sellAmount");
    const buyAmount = integer(q.buyAmount, "response buyAmount");
    if (sellAmount !== expected.sellAmount) throw new QuoteValidationError("Quote sell amount does not match the requested amount.");
    const minBuyAmount = integer(q.minBuyAmount, "response minBuyAmount");
    if (minBuyAmount > buyAmount) throw new QuoteValidationError("Minimum output cannot exceed quoted output.");
    const quotedSlippage = parseSlippageBps(q.slippageBps ?? expected.slippageBps);
    if (quotedSlippage > this.config.maximumSlippageBps || quotedSlippage !== expected.slippageBps) {
      throw new QuoteValidationError("Quote slippage differs from the approved request or exceeds its ceiling.");
    }

    const transaction = q.transaction;
    if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) throw new QuoteValidationError("Quote has no executable transaction.");
    const tx = transaction as Record<string, unknown>;
    const to = optionalAddress(tx.to, "transaction target");
    if (!to || !this.config.allowedTransactionTargets.some((target) => target.toLowerCase() === to.toLowerCase())) {
      throw new QuoteValidationError("Transaction target is not explicitly allowlisted.");
    }
    if (typeof tx.data !== "string" || !hexSchema.safeParse(tx.data).success || tx.data.length < 10) {
      throw new QuoteValidationError("Malformed transaction calldata.");
    }
    const value = integer(tx.value ?? "0", "transaction value", true);
    const gas = tx.gas !== undefined ? integer(tx.gas, "transaction gas") : undefined;
    const gasPrice = tx.gasPrice !== undefined ? integer(tx.gasPrice, "transaction gas price", true) : undefined;
    const allowanceTarget = optionalAddress(q.issues && typeof q.issues === "object" ? (q.issues as Record<string, unknown>).allowance : undefined, "allowance target");

    const maximumAge = this.config.maximumQuoteAgeMs ?? DEFAULT_QUOTE_MAX_AGE_MS;
    const now = this.config.now?.() ?? Date.now();
    const quoteTimestamp = typeof q.zid === "string" && /^\d{10,13}$/.test(q.zid)
      ? (q.zid.length === 10 ? Number(q.zid) * 1000 : Number(q.zid))
      : typeof q.blockNumber === "number" ? now : NaN;
    // 0x's firm quote response does not guarantee a trustworthy timestamp. Stamp receipt time,
    // while callers must not treat this local timestamp as an on-chain quote-age guarantee.
    const receivedAt = now;
    if (!Number.isFinite(maximumAge) || maximumAge <= 0) throw new QuoteValidationError("Invalid quote max age.");
    if (Number.isFinite(quoteTimestamp) && (quoteTimestamp > now + 1000 || now - quoteTimestamp > maximumAge)) {
      throw new QuoteValidationError("Quote timestamp is stale or in the future.");
    }
    const priceImpactBps = typeof q.expectedSlippage === "number" && Number.isFinite(q.expectedSlippage)
      ? Math.round(Math.max(0, q.expectedSlippage) * 10_000)
      : null;
    if (priceImpactBps !== null && priceImpactBps > this.config.maximumPriceImpactBps) {
      throw new QuoteValidationError("Quote expected slippage/price impact exceeds configured ceiling.");
    }
    const sources = Array.isArray(q.route) ? q.route.map((entry) => {
      if (!entry || typeof entry !== "object") return "";
      const source = (entry as Record<string, unknown>).source;
      return typeof source === "string" ? source : "";
    }).filter(Boolean) : [];
    const fees = q.fees && typeof q.fees === "object" ? Object.values(q.fees as Record<string, unknown>).flatMap((fee) => {
      if (fee && typeof fee === "object" && typeof (fee as Record<string, unknown>).amount === "string") return [(fee as Record<string, unknown>).amount as string];
      return [];
    }) : [];

    return {
      provider: "0x", chainId: 137, sellToken: expected.sellToken, buyToken: expected.buyToken,
      sellAmount, buyAmount, minBuyAmount, taker: expected.taker, allowanceTarget,
      transaction: { to, data: tx.data as `0x${string}`, value, ...(gas ? { gas } : {}), ...(gasPrice !== undefined ? { gasPrice } : {}) },
      liquiditySources: sources, estimatedGas: gas ?? null, quoteTimestamp: receivedAt,
      priceImpactBps, slippageBps: quotedSlippage, rawFeeAmounts: fees,
    };
  }
}

export function estimateQuoteAmounts(quote: ValidatedSwapQuote, sellDecimals: number, buyDecimals: number) {
  if (![sellDecimals, buyDecimals].every((d) => Number.isInteger(d) && d >= 0 && d <= 36)) {
    throw new QuoteValidationError("Token decimals must be integers from 0 to 36.");
  }
  return {
    sellAmountHuman: decimalAmount(quote.sellAmount, sellDecimals),
    buyAmountHuman: decimalAmount(quote.buyAmount, buyDecimals),
    minimumBuyAmountHuman: decimalAmount(quote.minBuyAmount, buyDecimals),
  };
}
