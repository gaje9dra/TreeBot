import { readFileSync } from "node:fs";
import { createLedgerPool } from "../src/lib/ledger/postgres";

async function main(): Promise<void> {
  const pool = createLedgerPool();

  try {
    const sql = readFileSync(
      new URL("../migrations/001_paper_ledger.sql", import.meta.url),
      "utf8",
    );
    await pool.query(sql);
    console.info("TreeBot paper-ledger schema migration applied.");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Failed to apply TreeBot paper-ledger schema migration:", error);
  process.exitCode = 1;
});
