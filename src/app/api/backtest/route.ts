import { NextResponse } from "next/server";
import { z } from "zod";
import { backtest } from "@/lib/trading/backtest";
import { loadMarketSnapshot, MarketProviderError } from "@/lib/market/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  pair: z.string().min(3).max(64).regex(/^[A-Za-z0-9:_/-]+$/),
  startingEquityQuote: z.number().finite().positive().max(1_000_000_000),
  notionalQuote: z.number().finite().positive().max(1_000_000_000),
}).refine((input) => input.notionalQuote <= input.startingEquityQuote, {
  path: ["notionalQuote"],
  message: "Order notional cannot exceed starting quote equity.",
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid backtest inputs.", details: parsed.error.flatten() }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  try {
    const snapshot = await loadMarketSnapshot(parsed.data.pair);
    if (snapshot.candles.length < 25) {
      return NextResponse.json({ error: "Backtesting requires at least 25 provider-supplied historical candles." }, { status: 422, headers: { "Cache-Control": "no-store" } });
    }
    const report = backtest(snapshot.candles, {
      startingEquityQuote: parsed.data.startingEquityQuote,
      notionalQuote: parsed.data.notionalQuote,
      feeBps: snapshot.swapFeeBps,
      slippageBps: snapshot.expectedSlippageBps,
      gasQuotePerTrade: snapshot.gasCostQuote,
    });
    return NextResponse.json({
      simulated: true,
      snapshot: { pair: snapshot.pair, observedAt: snapshot.observedAt, candleCount: snapshot.candles.length },
      report,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof MarketProviderError) {
      const status = error.code === "NOT_CONFIGURED" ? 503 : error.code === "INVALID_CONFIG" ? 400 : 502;
      return NextResponse.json({ error: error.message, code: error.code }, { status, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Backtest failed." }, { status: 422, headers: { "Cache-Control": "no-store" } });
  }
}
