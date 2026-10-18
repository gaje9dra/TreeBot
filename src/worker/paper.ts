import { loadEnvConfig } from "next/env";
import { createLedgerPool, PostgresPaperLedger } from "@/lib/ledger/postgres";
import { runPaperCycle } from "@/lib/worker/paper-cycle";

loadEnvConfig(process.cwd());

const pairs = (process.env.TREEBOT_MARKET_PAIRS ?? "")
  .split(",")
  .map((pair) => pair.trim())
  .filter(Boolean);
const pollMs = Math.max(5_000, Number(process.env.TREEBOT_PAPER_POLL_MS ?? 15_000));

if (pairs.length === 0) {
  throw new Error("Set TREEBOT_MARKET_PAIRS to one or more provider pair identifiers before starting the paper worker.");
}
if (!Number.isFinite(pollMs)) throw new Error("TREEBOT_PAPER_POLL_MS must be a finite number.");

const pool = createLedgerPool();
const ledger = new PostgresPaperLedger(pool);
let stopping = false;
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });

async function main() {
  await pool.query("SELECT 1");
  console.info(JSON.stringify({ event: "paper-worker-started", pairs, pollMs, mode: "paper-only" }));
  try {
    while (!stopping) {
      for (const pair of pairs) {
        if (stopping) break;
        try {
          const result = await runPaperCycle(pair, Date.now(), { ledger });
          console.info(JSON.stringify({ event: "paper-cycle", pair, ...result }));
        } catch (error) {
          console.error(JSON.stringify({
            event: "paper-cycle-failed",
            pair,
            error: error instanceof Error ? error.message : "Unknown worker error",
          }));
        }
      }
      if (!stopping) await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    await pool.end();
    console.info(JSON.stringify({ event: "paper-worker-stopped" }));
  }
}

void main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : "Paper worker failed to start.");
  await pool.end();
  process.exitCode = 1;
});
