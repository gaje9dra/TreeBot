import { describe, expect, it, vi } from "vitest";
import { ZeroExPolygonQuoteAdapter, QuoteValidationError, estimateQuoteAmounts } from "./zero-ex";
import type { Address } from "viem";

const sell = "0x0000000000000000000000000000000000000001" as Address;
const buy = "0x0000000000000000000000000000000000000002" as Address;
const taker = "0x0000000000000000000000000000000000000003" as Address;
const target = "0x0000000000000000000000000000000000000004" as Address;

function fixture(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 137, sellToken: sell, buyToken: buy, taker, sellAmount: "1000000", buyAmount: "2500000",
    minBuyAmount: "2487500", slippageBps: 50, transaction: { to: target, data: "0x12345678", value: "0", gas: "150000" },
    route: [{ source: "QuickSwap" }], fees: {}, ...overrides,
  };
}
function adapter(fetcher?: typeof fetch) {
  return new ZeroExPolygonQuoteAdapter({
    apiKey: "test-key", allowedTokens: [
      { address: sell, symbol: "A", decimals: 6 }, { address: buy, symbol: "B", decimals: 6 },
    ], allowedTransactionTargets: [target], maximumSlippageBps: 50, maximumPriceImpactBps: 100,
    now: () => 1_800_000_000_000, fetcher,
  });
}
function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("0x Polygon quote adapter", () => {
  it("requests chain 137 and validates a supported executable quote", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response(fixture()));
    const quote = await adapter(fetcher as typeof fetch).getFirmQuote({
      sellToken: sell, buyToken: buy, sellAmount: "1000000", taker, chainId: 137, slippageBps: 50,
    });
    expect(quote.chainId).toBe(137);
    expect(quote.transaction.to).toBe(target);
    expect(quote.estimatedGas).toBe(150000n);
    expect(fetcher).toHaveBeenCalledOnce();
    const calledUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(calledUrl.searchParams.get("chainId")).toBe("137");
  });

  it("rejects wrong chain, unallowlisted tokens, and unallowlisted destinations", async () => {
    await expect(adapter().getFirmQuote({ sellToken: sell, buyToken: buy, sellAmount: "1", taker, chainId: 1, slippageBps: 50 })).rejects.toThrow(/chain ID/);
    await expect(adapter().getFirmQuote({ sellToken: sell, buyToken: "0x0000000000000000000000000000000000000005", sellAmount: "1", taker, chainId: 137, slippageBps: 50 })).rejects.toThrow(/allowlist/);
    const bad = adapter(async () => response(fixture({ transaction: { to: "0x0000000000000000000000000000000000000005", data: "0x12345678", value: "0" } })));
    await expect(bad.getFirmQuote({ sellToken: sell, buyToken: buy, sellAmount: "1000000", taker, chainId: 137, slippageBps: 50 })).rejects.toThrow(/target/);
  });

  it("rejects malformed output, amounts, calldata, and excessive slippage", async () => {
    await expect(adapter(async () => response(fixture({ buyAmount: "0" }))).getFirmQuote({ sellToken: sell, buyToken: buy, sellAmount: "1000000", taker, chainId: 137, slippageBps: 50 })).rejects.toThrow(QuoteValidationError);
    await expect(
      adapter(async () => response(fixture({ transaction: { to: target, data: "not-hex", value: "0" } }))).getFirmQuote({
        sellToken: sell, buyToken: buy, sellAmount: "1000000", taker, chainId: 137, slippageBps: 50,
      }),
    ).rejects.toThrow(/calldata/);
    await expect(adapter().getFirmQuote({ sellToken: sell, buyToken: buy, sellAmount: "1000000", taker, chainId: 137, slippageBps: 51 })).rejects.toThrow(/ceiling/);
  });

  it("converts base units using token decimals without conflating a price snapshot", () => {
    const quote = {
      provider: "0x" as const, chainId: 137 as const, sellToken: sell, buyToken: buy, sellAmount: 1000000n, buyAmount: 2500000n,
      minBuyAmount: 2487500n, taker, allowanceTarget: null,
      transaction: { to: target, data: "0x12345678" as `0x${string}`, value: 0n },
      liquiditySources: [], estimatedGas: null, quoteTimestamp: 1, priceImpactBps: null, slippageBps: 50, rawFeeAmounts: [],
    };
    expect(estimateQuoteAmounts(quote, 6, 6)).toEqual({ sellAmountHuman: 1, buyAmountHuman: 2.5, minimumBuyAmountHuman: 2.4875 });
  });
});
