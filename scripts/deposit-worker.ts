import { loadEnvConfig } from "@next/env";
import { createLedgerPool } from "@/lib/ledger/postgres";
import { loadConfig } from "@/lib/config";
import { PostgresDepositScannerStore } from "@/lib/execution/postgres";
import { PolygonDepositScanner } from "@/lib/execution/deposit-scanner";
import { ViemPolygonDepositReader } from "@/lib/execution/polygon-deposit-reader";
import { assertDepositWorkerActivation, parseDepositWorkerSettings, runDepositWorker } from "@/lib/execution/deposit-worker";

loadEnvConfig(process.cwd());

async function main(): Promise<void> {
  if (process.env.TREEBOT_DEPOSITS_ENABLED !== "true") {
    console.info(JSON.stringify({ event: "deposit-worker-disabled", reason: "TREEBOT_DEPOSITS_ENABLED is not true" }));
    return;
  }

  // This build intentionally fails closed until independent review and explicit activation are approved.
  assertDepositWorkerActivation(process.env);
  const config = loadConfig(process.env);
  const settings = parseDepositWorkerSettings(process.env);
  const pool = createLedgerPool(process.env);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    const primary = new ViemPolygonDepositReader(settings.primaryRpcUrl);
    const fallback = new ViemPolygonDepositReader(settings.fallbackRpcUrl);
    const store = new PostgresDepositScannerStore(pool);
    const scanner = new PolygonDepositScanner(primary, store, {
      watcherKey: settings.workerKey,
      startBlock: settings.startBlock,
      vaultAddress: settings.vaultAddress,
      supportedTokenAddresses: settings.tokenAddresses,
      creditingEnabled: true,
      tokenDecimalsByAddress: settings.tokenDecimalsByAddress,
      confirmations: settings.confirmations,
      maxBlockRange: settings.maxBlockRange,
      accountForSender: async (sender) => settings.senderAccountMap[sender.toLowerCase()] ?? null,
    });
    await runDepositWorker({
      pool,
      settings,
      scanner,
      primary,
      fallback,
      shouldStop: () => stopping,
      sleep: async (milliseconds) => {
        const deadline = Date.now() + milliseconds;
        while (!stopping && Date.now() < deadline) {
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
        }
      },
    });
    if (config.depositsEnabled !== true) throw new Error("Deposit worker activation was not accepted by configuration.");
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await pool.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    event: "deposit-worker-failed",
    error: (error instanceof Error ? error.message : "Unknown worker failure").slice(0, 1000),
  }));
  process.exitCode = 1;
});
