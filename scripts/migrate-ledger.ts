import { readFileSync } from "node:fs";
import { createLedgerPool } from "../src/lib/ledger/postgres";

const pool = createLedgerPool();
try {
  const sql = readFileSync(new URL("../migrations/001_paper_ledger.sql", import.meta.url), "utf8");
  await pool.query(sql);
  console.info("TreeBot paper-ledger schema migration applied.");
} finally {
  await pool.end();
}
