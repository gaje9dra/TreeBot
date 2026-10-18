import { NextResponse } from "next/server";
import { createLedgerPool, PostgresPaperLedger } from "@/lib/ledger/postgres";
import { loadMarketSnapshot, MarketProviderError } from "@/lib/market/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const envPairs = (process.env.TREEBOT_MARKET_PAIRS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const pair = new URL(request.url).searchParams.get("pair")?.trim() || envPairs[0];
  if (!pair || !/^[A-Za-z0-9:_/-]{3,64}$/.test(pair)) {
    return NextResponse.json({ error: "Configure TREEBOT_MARKET_PAIRS or provide a valid pair query parameter." }, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  let markPrice: number | undefined;
  let marketDataError: string | undefined;
  try {
    const snapshot = await loadMarketSnapshot(pair);
    markPrice = snapshot.price;
  } catch (error) {
    marketDataError = error instanceof MarketProviderError ? error.message : "Market data provider is unavailable.";
  }

  let pool;
  try {
    pool = createLedgerPool();
    const ledger = new PostgresPaperLedger(pool);
    const dashboard = await ledger.getDashboard(pair, markPrice);
    return NextResponse.json({
      ...dashboard,
      marketDataAvailable: markPrice !== undefined,
      ...(marketDataError ? { marketDataError } : {}),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({
      error: "Paper ledger is unavailable. Verify DATABASE_URL and run npm run ledger:migrate.",
      marketDataAvailable: markPrice !== undefined,
      ...(marketDataError ? { marketDataError } : {}),
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  } finally {
    if (pool) await pool.end();
  }
}
