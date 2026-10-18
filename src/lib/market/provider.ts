import { z } from "zod";
import { validateCandles } from "@/lib/trading/indicators";
import type { MarketSnapshot } from "@/lib/trading/types";

const candleSchema = z.object({
  timestamp: z.number().int().positive(),
  open: z.number().finite().positive(),
  high: z.number().finite().positive(),
  low: z.number().finite().positive(),
  close: z.number().finite().positive(),
  volume: z.number().finite().nonnegative(),
});

const snapshotSchema = z.object({
  pair: z.string().min(3).max(64),
  baseToken: z.string().min(1).max(128),
  quoteToken: z.string().min(1).max(128),
  observedAt: z.number().int().positive(),
  price: z.number().finite().positive(),
  bid: z.number().finite().positive().optional(),
  ask: z.number().finite().positive().optional(),
  volume24h: z.number().finite().nonnegative(),
  liquidityUsd: z.number().finite().nonnegative(),
  gasCostQuote: z.number().finite().nonnegative(),
  swapFeeBps: z.number().finite().nonnegative().max(10_000),
  expectedSlippageBps: z.number().finite().nonnegative().max(10_000),
  executableExit: z.boolean(),
  candles: z.array(candleSchema).min(22).max(10_000),
});

export class MarketProviderError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_CONFIGURED" | "INVALID_CONFIG" | "UPSTREAM" | "INVALID_DATA" | "STALE_DATA",
  ) {
    super(message);
    this.name = "MarketProviderError";
  }
}

export interface MarketProviderOptions {
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
  now?: number;
  maxAgeMs?: number;
}

export async function loadMarketSnapshot(
  pair: string,
  options: MarketProviderOptions = {},
): Promise<MarketSnapshot> {
  if (!/^[A-Za-z0-9:_/-]{3,64}$/.test(pair)) {
    throw new MarketProviderError("Invalid pair identifier.", "INVALID_CONFIG");
  }

  const env = options.env ?? process.env;
  const base = env.MARKET_DATA_BASE_URL;
  if (!base) throw new MarketProviderError("Market data provider is not configured.", "NOT_CONFIGURED");

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new MarketProviderError("Market data provider URL is invalid.", "INVALID_CONFIG");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new MarketProviderError("Market data provider must use HTTPS and must not embed credentials.", "INVALID_CONFIG");
  }

  const endpoint = new URL("snapshot", base.endsWith("/") ? base : base + "/");
  endpoint.searchParams.set("pair", pair);
  const headers = new Headers({ accept: "application/json" });
  if (env.MARKET_DATA_API_KEY) headers.set("authorization", `Bearer ${env.MARKET_DATA_API_KEY}`);

  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(endpoint, {
      method: "GET",
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new MarketProviderError("Market data provider request failed or timed out.", "UPSTREAM");
  }
  if (!response.ok) throw new MarketProviderError(`Market data provider returned HTTP ${response.status}.`, "UPSTREAM");

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new MarketProviderError("Market data provider returned invalid JSON.", "INVALID_DATA");
  }
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MarketProviderError("Market data response does not match the normalized snapshot contract.", "INVALID_DATA");
  }

  const snapshot = parsed.data;
  if (snapshot.pair.toLowerCase() !== pair.toLowerCase()) {
    throw new MarketProviderError("Market data provider returned a different pair.", "INVALID_DATA");
  }
  if (snapshot.bid !== undefined && snapshot.ask !== undefined && snapshot.bid > snapshot.ask) {
    throw new MarketProviderError("Market data bid/ask spread is invalid.", "INVALID_DATA");
  }
  if (validateCandles(snapshot.candles).length > 0) {
    throw new MarketProviderError("Market data candles failed integrity checks.", "INVALID_DATA");
  }

  const age = (options.now ?? Date.now()) - snapshot.observedAt;
  if (age < -10_000 || age > (options.maxAgeMs ?? 60_000)) {
    throw new MarketProviderError("Market data is stale or has a future timestamp.", "STALE_DATA");
  }

  return snapshot as MarketSnapshot;
}
