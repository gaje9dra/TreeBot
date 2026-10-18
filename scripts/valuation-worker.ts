import { loadEnvConfig } from "@next/env";
import { createLedgerPool } from "@/lib/ledger/postgres";
import {
  assertValuationWorkerActivation,
  createViemPublicClient,
  createViemValuationReader,
  parseValuationWorkerSettings,
  runValuationWorker,
} from "@/lib/execution/valuation-worker";

async function main():Promise<void>{
  loadEnvConfig(process.cwd());
  if(process.env.TREEBOT_VALUATIONS_ENABLED!=="true"){
    console.info("TreeBot valuation worker is disabled; no RPC or database connection was opened.");
    return;
  }
  assertValuationWorkerActivation(process.env);
  const settings=parseValuationWorkerSettings(process.env);
  const pool=createLedgerPool(process.env);
  let stopping=false;
  const stop=()=>{stopping=true;};
  process.once("SIGINT",stop);
  process.once("SIGTERM",stop);
  try{
    await runValuationWorker({
      pool,settings,
      primary:createViemValuationReader(createViemPublicClient(settings.primaryRpcUrl)),
      fallback:createViemValuationReader(createViemPublicClient(settings.fallbackRpcUrl)),
      shouldStop:()=>stopping,
      sleep:(ms)=>new Promise((resolve)=>setTimeout(resolve,ms)),
    });
  }finally{
    process.removeListener("SIGINT",stop);
    process.removeListener("SIGTERM",stop);
    await pool.end();
  }
}
main().catch((error:unknown)=>{
  console.error("TreeBot valuation worker stopped:",error instanceof Error?error.message:"Unknown error");
  process.exitCode=1;
});
