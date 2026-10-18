import { loadEnvConfig } from "@next/env";
import { createLedgerPool } from "@/lib/ledger/postgres";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

loadEnvConfig(process.cwd());

const pool = createLedgerPool();
const migrations = [
  "migrations/001_paper_ledger.sql",
  "migrations/002_execution_lifecycle.sql",
  "migrations/003_execution_controls.sql",
  "migrations/004_fund_lifecycle.sql",
  "migrations/005_deposit_scanner_recovery.sql",
  "migrations/006_account_restrictions.sql",
];

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(731204137)");
    for (const migration of migrations) {
      const sql = await readFile(resolve(process.cwd(), migration), "utf8");
      await client.query(sql);
      console.info(JSON.stringify({ event:"migration-applied", migration }));
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Migration failed.");
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
