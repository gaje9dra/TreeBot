import { describe, expect, it, vi } from "vitest";
import { loadMarketSnapshot, MarketProviderError } from "./provider";

const now = 1_800_000_000_000;
const candles = Array.from({ length: 22 }, (_, i) => ({
  timestamp: now - (21 - i) * 60_000,
  open: 100 + i,
  high: 102 + i,
  low: 99 + i,
  close: 101 + i,
  volume: 1_000,
}));
const snapshot = {
  pair: "WMATIC/USDC",
  baseToken: "0x0000000000000000000000000000000000000001",
  quoteToken: "0x0000000000000000000000000000000000000002",
  observedAt: now,
  price: 101,
  bid: 100.9,
  ask: 101.1,
  volume24h: 50_000,
  liquidityUsd: 100_000,
  gasCostQuote: 0.02,
  swapFeeBps: 30,
  expectedSlippageBps: 20,
  executableExit: true,
  candles,
};

function fetchResponse(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
}

describe("configured market-data provider", () => {
  it("loads and validates a fresh normalized snapshot without exposing provider secrets", async () => {
    const fetcher = fetchResponse(snapshot);
    const result = await loadMarketSnapshot("WMATIC/USDC", {
      now,
      env: { MARKET_DATA_BASE_URL: "https://market.example/api", MARKET_DATA_API_KEY: "secret-test-key" },
      fetcher,
    });
    expect(result).toEqual(snapshot);
    expect(fetcher).toHaveBeenCalledOnce();
    const [, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret-test-key");
    expect(String(fetcher.mock.calls[0][0])).toContain("pair=WMATIC%2FUSDC");
  });

  it("rejects missing configuration and insecure provider URLs", async () => {
    await expect(loadMarketSnapshot("WMATIC/USDC", { env: {} })).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    await expect(loadMarketSnapshot("WMATIC/USDC", {
      env: { MARKET_DATA_BASE_URL: "http://market.example" },
      fetcher: fetchResponse(snapshot),
    })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("rejects stale, mismatched, malformed, and unavailable provider responses", async () => {
    await expect(loadMarketSnapshot("WMATIC/USDC", {
      now: now + 120_000,
      env: { MARKET_DATA_BASE_URL: "https://market.example" },
      fetcher: fetchResponse(snapshot),
    })).rejects.toMatchObject({ code: "STALE_DATA" });

    await expect(loadMarketSnapshot("WETH/USDC", {
      now,
      env: { MARKET_DATA_BASE_URL: "https://market.example" },
      fetcher: fetchResponse(snapshot),
    })).rejects.toMatchObject({ code: "INVALID_DATA" });

    await expect(loadMarketSnapshot("WMATIC/USDC", {
      now,
      env: { MARKET_DATA_BASE_URL: "https://market.example" },
      fetcher: fetchResponse(snapshot, 502),
    })).rejects.toMatchObject({ code: "UPSTREAM" });
  });
});
