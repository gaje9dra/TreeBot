import { loadEnvConfig } from "next/env";
import { createLedgerPool } from "../src/lib/ledger/postgres";

loadEnvConfig(process.cwd());

const command = process.argv[2];
const pool = createLedgerPool();

async function main() {
  if (command === "enable") {
    const result = await pool.query(
      "UPDATE treebot_control SET paper_enabled = TRUE, updated_at = NOW() WHERE id = 1 AND emergency_stop = FALSE RETURNING id",
    );
    if (result.rowCount === 0) throw new Error("Paper trading cannot be enabled while the emergency stop is active. Run clear-stop, review conditions, then enable.");
    console.info("Paper trading enabled. This only enables simulated fills; live execution remains unavailable.");
  } else if (command === "disable") {
    await pool.query("UPDATE treebot_control SET paper_enabled = FALSE, updated_at = NOW() WHERE id = 1");
    console.info("Paper trading disabled; no new simulated entries will be recorded.");
  } else if (command === "emergency-stop") {
    await pool.query("UPDATE treebot_control SET paper_enabled = FALSE, emergency_stop = TRUE, updated_at = NOW() WHERE id = 1");
    console.warn("PAPER EMERGENCY STOP ACTIVE. New simulated entries are blocked.");
  } else if (command === "clear-stop") {
    await pool.query("UPDATE treebot_control SET paper_enabled = FALSE, emergency_stop = FALSE, updated_at = NOW() WHERE id = 1");
    console.info("Emergency stop cleared but paper trading remains disabled. Explicitly enable only after reviewing state.");
  } else {
    throw new Error("Usage: npm run paper:control -- enable|disable|emergency-stop|clear-stop");
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Paper control command failed.");
  process.exitCode = 1;
} finally {
  await pool.end();
}
