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

const GECKO_API = "https://api.geckoterminal.com/api/v2";
type JsonRecord = Record<string, unknown>;

async function getJson(url: URL, fetcher: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new MarketProviderError("Market data provider request failed or timed out.", "UPSTREAM");
  }
  if (!response.ok) {
    const detail = response.status === 429 ? " rate limit reached; wait before retrying." : ` HTTP ${response.status}.`;
    throw new MarketProviderError("GeckoTerminal request failed." + detail, "UPSTREAM");
  }
  try {
    return await response.json();
  } catch {
    throw new MarketProviderError("Market data provider returned invalid JSON.", "INVALID_DATA");
  }
}
function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}
function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}
function tokenSymbol(included: unknown, tokenId: string | undefined): string | undefined {
  if (!Array.isArray(included) || !tokenId) return undefined;
  for (const entry of included) {
    const item = record(entry);
    const attrs = record(item?.attributes);
    if (item?.id === tokenId && typeof attrs?.symbol === "string") return attrs.symbol;
  }
  return undefined;
}
function normalizedSymbol(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^W(?=MATIC$)/, "W");
}
function requestedSymbols(pair: string): [string, string] {
  const parts = pair.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new MarketProviderError("Use a base/quote pair such as WMATIC/USDC.", "INVALID_CONFIG");
  }
  return [normalizedSymbol(parts[0]), normalizedSymbol(parts[1])];
}

/**
 * Uses GeckoTerminal's public Polygon PoS DEX data when no normalized provider
 * is configured. It is read-only market data: this does not quote or execute swaps.
 */
async function loadGeckoTerminalSnapshot(pair: string, options: MarketProviderOptions): Promise<MarketSnapshot> {
  const fetcher = options.fetcher ?? fetch;
  const [baseRequested, quoteRequested] = requestedSymbols(pair);
  const search = new URL(GECKO_API + "/search/pools");
  search.searchParams.set("query", pair.replace("/", " "));
  const searchRaw = record(await getJson(search, fetcher));
  const searchData = record(searchRaw?.data);
  const pools = Array.isArray(searchData?.data) ? searchData.data : Array.isArray(searchRaw?.data) ? searchRaw.data : [];
  const included = searchRaw?.included;
  const candidates = pools.map((entry) => {
    const item = record(entry);
    const attrs = record(item?.attributes);
    const rel = record(item?.relationships);
    const baseTokenId = record(rel?.base_token)?.data && record(record(rel?.base_token)?.data)?.id;
    const quoteTokenId = record(rel?.quote_token)?.data && record(record(rel?.quote_token)?.data)?.id;
    const baseSymbol = tokenSymbol(included, typeof baseTokenId === "string" ? baseTokenId : undefined);
    const quoteSymbol = tokenSymbol(included, typeof quoteTokenId === "string" ? quoteTokenId : undefined);
    return { item, attrs, baseSymbol, quoteSymbol, baseTokenId, quoteTokenId, reserve: numberValue(attrs?.reserve_in_usd) ?? 0 };
  }).filter((candidate) =>
    candidate.baseSymbol && candidate.quoteSymbol &&
    normalizedSymbol(candidate.baseSymbol) === baseRequested &&
    normalizedSymbol(candidate.quoteSymbol) === quoteRequested &&
    typeof candidate.attrs?.address === "string" &&
    candidate.reserve > 0,
  ).sort((a, b) => b.reserve - a.reserve);
  const selected = candidates[0];
  if (!selected?.attrs) {
    throw new MarketProviderError(`No liquid Polygon PoS pool matching ${pair} was found. Check the pair symbols or configure a normalized provider.`, "INVALID_DATA");
  }
  const poolAddress = selected.attrs.address as string;
  const price = numberValue(selected.attrs.base_token_price_quote_token);
  if (!price || price <= 0) {
    throw new MarketProviderError("Selected pool has no valid base/quote price.", "INVALID_DATA");
  }
  const candleUrl = new URL(`${GECKO_API}/networks/polygon_pos/pools/${encodeURIComponent(poolAddress)}/ohlcv/hour`);
  candleUrl.searchParams.set("aggregate", "1");
  candleUrl.searchParams.set("limit", "200");
  candleUrl.searchParams.set("currency", "token");
  candleUrl.searchParams.set("token", "quote");
  const candleRaw = record(await getJson(candleUrl, fetcher));
  const candleData = record(candleRaw?.data);
  const candleAttrs = record(candleData?.attributes);
  const rows = candleAttrs?.ohlcv_list;
  if (!Array.isArray(rows)) throw new MarketProviderError("GeckoTerminal returned no historical candle series.", "INVALID_DATA");
  const candles = rows.map((row) => {
    if (!Array.isArray(row) || row.length < 6) return undefined;
    const [timestamp, open, high, low, close, volume] = row;
    const values = [timestamp, open, high, low, close, volume].map(numberValue);
    if (values.some((value) => value === undefined)) return undefined;
    const [ts, o, h, l, c, v] = values as number[];
    return { timestamp: ts * 1000, open: o, high: h, low: l, close: c, volume: Math.max(0, v) };
  }).filter((candle): candle is NonNullable<typeof candle> => candle !== undefined).sort((a, b) => a.timestamp - b.timestamp);
  if (candles.length < 22) throw new MarketProviderError("At least 22 valid hourly candles are required; this pool has insufficient history.", "INVALID_DATA");
  if (validateCandles(candles).length > 0) throw new MarketProviderError("GeckoTerminal candles failed integrity checks.", "INVALID_DATA");

  const now = options.now ?? Date.now();
  // GeckoTerminal does not provide an executable bid/ask quote. Exit capability
  // remains false so the strategy cannot treat data availability as swap readiness.
  const snapshot = {
    pair,
    baseToken: selected.baseSymbol!,
    quoteToken: selected.quoteSymbol!,
    observedAt: now,
    price,
    volume24h: numberValue(record(selected.attrs.volume_usd)?.h24) ?? 0,
    liquidityUsd: selected.reserve,
    gasCostQuote: 0,
    swapFeeBps: 30,
    expectedSlippageBps: 50,
    executableExit: false,
    candles,
  };
  const parsed = snapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw new MarketProviderError("GeckoTerminal response could not be normalized safely.", "INVALID_DATA");
  return parsed.data;
}

export async function loadMarketSnapshot(pair: string, options: MarketProviderOptions = {}): Promise<MarketSnapshot> {
  if (!/^[A-Za-z0-9:_/-]{3,64}$/.test(pair)) {
    throw new MarketProviderError("Invalid pair identifier.", "INVALID_CONFIG");
  }
  const env = options.env ?? process.env;
  const base = env.MARKET_DATA_BASE_URL;
  if (!base) return loadGeckoTerminalSnapshot(pair, options);

  let url: URL;
  try { url = new URL(base); }
  catch { throw new MarketProviderError("Market data provider URL is invalid.", "INVALID_CONFIG"); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new MarketProviderError("Market data provider must use HTTPS and must not embed credentials.", "INVALID_CONFIG");
  }
  const endpoint = new URL("snapshot", base.endsWith("/") ? base : base + "/");
  endpoint.searchParams.set("pair", pair);
  const headers = new Headers({ accept: "application/json" });
  if (env.MARKET_DATA_API_KEY) headers.set("authorization", `Bearer ${env.MARKET_DATA_API_KEY}`);
  const raw = await getJsonWithHeaders(endpoint, options.fetcher ?? fetch, headers);
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success) throw new MarketProviderError("Market data response does not match the normalized snapshot contract.", "INVALID_DATA");
  const snapshot = parsed.data;
  if (snapshot.pair.toLowerCase() !== pair.toLowerCase()) throw new MarketProviderError("Market data provider returned a different pair.", "INVALID_DATA");
  if (snapshot.bid !== undefined && snapshot.ask !== undefined && snapshot.bid > snapshot.ask) throw new MarketProviderError("Market data bid/ask spread is invalid.", "INVALID_DATA");
  if (validateCandles(snapshot.candles).length > 0) throw new MarketProviderError("Market data candles failed integrity checks.", "INVALID_DATA");
  const age = (options.now ?? Date.now()) - snapshot.observedAt;
  if (age < -10_000 || age > (options.maxAgeMs ?? 60_000)) throw new MarketProviderError("Market data is stale or has a future timestamp.", "STALE_DATA");
  return snapshot;
}

async function getJsonWithHeaders(url: URL, fetcher: typeof fetch, headers: Headers): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { method: "GET", headers, cache: "no-store", signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new MarketProviderError("Market data provider request failed or timed out.", "UPSTREAM");
  }
  if (!response.ok) throw new MarketProviderError(`Market data provider returned HTTP ${response.status}.`, "UPSTREAM");
  try { return await response.json(); }
  catch { throw new MarketProviderError("Market data provider returned invalid JSON.", "INVALID_DATA"); }
}
