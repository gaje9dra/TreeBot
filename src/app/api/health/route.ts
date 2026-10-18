import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export function GET() {
  try {
    const config = loadConfig();
    return NextResponse.json({
      status: "ok",
      service: "treebot",
      chainId: config.chainId,
      mode: config.tradingMode,
      liveExecutionEnabled: false,
      depositsEnabled: false,
      timestamp: new Date().toISOString()
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ status: "error", service: "treebot", timestamp: new Date().toISOString() }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
