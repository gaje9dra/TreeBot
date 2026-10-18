import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadMarketSnapshot } from "@/lib/market/provider";
import { POST } from "./route";

vi.mock("@/lib/market/provider", () => ({
  loadMarketSnapshot: vi.fn(),
  MarketProviderError: class MarketProviderError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  },
}));

const now = 1_800_000_000_000;
const candles = Array.from({ length: 30 }, (_, index) => {
  const close = 100 + Math.sin(index / 2) * 2 + index * 0.1;
  return {
    timestamp: now - (29 - index) * 60_000,
    open: close - 0.1,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1_000,
  };
});

const snapshot = {
  pair: "WMATIC/USDC",
  baseToken: "0x0000000000000000000000000000000000000001",
  quoteToken: "0x0000000000000000000000000000000000000002",
  observedAt: now,
  price: candles[candles.length - 1].close,
  volume24h: 50_000,
  liquidityUsd: 100_000,
  gasCostQuote: 0.02,
  swapFeeBps: 30,
  expectedSlippageBps: 20,
  executableExit: true,
  candles,
};

function request(body: unknown) {
  return new Request("http://localhost/api/backtest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/backtest integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadMarketSnapshot).mockResolvedValue(snapshot);
  });

  it("rejects invalid inputs before calling the provider", async () => {
    const response = await POST(request({
      pair: "x",
      startingEquityQuote: -1,
      notionalQuote: 100,
    }));
    expect(response.status).toBe(400);
    expect(loadMarketSnapshot).not.toHaveBeenCalled();
  });

  it("returns a clearly marked simulated report from provider candles", async () => {
    const response = await POST(request({
      pair: "WMATIC/USDC",
      startingEquityQuote: 1_000,
      notionalQuote: 100,
    }));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.simulated).toBe(true);
    expect(payload.snapshot.candleCount).toBe(30);
    expect(payload.report.simulated).toBe(true);
    expect(Number.isFinite(payload.report.netReturnPercent)).toBe(true);
  });

  it("rejects insufficient history rather than fabricating candles", async () => {
    vi.mocked(loadMarketSnapshot).mockResolvedValueOnce({
      ...snapshot,
      candles: candles.slice(0, 22),
    });
    const response = await POST(request({
      pair: "WMATIC/USDC",
      startingEquityQuote: 1_000,
      notionalQuote: 100,
    }));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain("at least 25");
  });
});
