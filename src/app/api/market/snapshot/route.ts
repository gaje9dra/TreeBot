import { NextResponse } from "next/server";
import { loadMarketSnapshot, MarketProviderError } from "@/lib/market/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const pair = new URL(request.url).searchParams.get("pair")?.trim();
  if (!pair) {
    return NextResponse.json({ error: "Missing required pair query parameter." }, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    const snapshot = await loadMarketSnapshot(pair);
    return NextResponse.json({ data: snapshot, simulated: false }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof MarketProviderError) {
      const status = error.code === "NOT_CONFIGURED" ? 503
        : error.code === "INVALID_CONFIG" ? 400
        : error.code === "STALE_DATA" ? 502
        : 502;
      return NextResponse.json({ error: error.message, code: error.code }, {
        status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    return NextResponse.json({ error: "Market data is temporarily unavailable." }, {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
