import { getAddress, isAddress, type Address } from "viem";
import type { Pool } from "pg";
import { DEPOSIT_FEATURE_AVAILABLE, loadConfig } from "@/lib/config";
import type { DepositRangeReader, PolygonDepositScanner } from "./deposit-scanner";

export interface DepositWorkerSettings {
  workerKey: string;
  primaryRpcUrl: string;
  fallbackRpcUrl: string;
  vaultAddress: Address;
  tokenAddresses: Address[];
  tokenDecimalsByAddress: Record<string, number>;
  senderAccountMap: Record<string, string>;
  startBlock: bigint;
  confirmations: number;
  maxBlockRange: number;
  pollIntervalMs: number;
  stalledAfterMs: number;
  alertWebhookUrl: string;
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(key + " is required to configure the deposit worker.");
  return value;
}

function httpsOrLocalUrl(value: string, key: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(key + " must be a valid URL."); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error(key + " must use HTTPS outside local development.");
  }
  return url.toString();
}

function boundedInteger(value: string | undefined, fallback: number, key: string, min: number, max: number): number {
  const result = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error(key + " must be an integer between " + min + " and " + max + ".");
  }
  return result;
}

export function parseDepositWorkerSettings(env: Record<string, string | undefined>): DepositWorkerSettings {
  const primaryRpcUrl = httpsOrLocalUrl(required(env, "POLYGON_RPC_URL"), "POLYGON_RPC_URL");
  const fallbackRpcUrl = httpsOrLocalUrl(required(env, "POLYGON_RPC_FALLBACK_URL"), "POLYGON_RPC_FALLBACK_URL");
  if (primaryRpcUrl === fallbackRpcUrl) throw new Error("Primary and fallback Polygon RPC endpoints must be different.");
  const vault = required(env, "TREEBOT_DEPOSIT_VAULT_ADDRESS");
  if (!isAddress(vault)) throw new Error("TREEBOT_DEPOSIT_VAULT_ADDRESS must be a valid address.");
  const workerKey = required(env, "TREEBOT_DEPOSIT_WATCHER_KEY");
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(workerKey)) throw new Error("TREEBOT_DEPOSIT_WATCHER_KEY contains unsupported characters.");

  let tokenJson: unknown;
  let decimalsJson: unknown;
  let senderJson: unknown;
  try { tokenJson = JSON.parse(required(env, "TREEBOT_DEPOSIT_TOKENS_JSON")); } catch { throw new Error("TREEBOT_DEPOSIT_TOKENS_JSON must be valid JSON."); }
  try { decimalsJson = JSON.parse(required(env, "TREEBOT_DEPOSIT_TOKEN_DECIMALS_JSON")); } catch { throw new Error("TREEBOT_DEPOSIT_TOKEN_DECIMALS_JSON must be valid JSON."); }
  try { senderJson = JSON.parse(required(env, "TREEBOT_DEPOSIT_SENDER_MAP_JSON")); } catch { throw new Error("TREEBOT_DEPOSIT_SENDER_MAP_JSON must be valid JSON."); }
  if (!Array.isArray(tokenJson) || tokenJson.length === 0 || !tokenJson.every((value) => typeof value === "string" && isAddress(value))) {
    throw new Error("TREEBOT_DEPOSIT_TOKENS_JSON must be a non-empty array of token addresses.");
  }
  const tokenAddresses = [...new Set(tokenJson.map((value) => getAddress(value as string)))];
  if (tokenAddresses.length !== tokenJson.length) throw new Error("TREEBOT_DEPOSIT_TOKENS_JSON contains duplicate token addresses.");
  if (typeof decimalsJson !== "object" || decimalsJson === null || Array.isArray(decimalsJson)) {
    throw new Error("TREEBOT_DEPOSIT_TOKEN_DECIMALS_JSON must be an address-to-decimals object.");
  }
  const tokenDecimalsByAddress: Record<string, number> = {};
  for (const [address, decimals] of Object.entries(decimalsJson as Record<string, unknown>)) {
    if (!isAddress(address) || !tokenAddresses.some((token) => token.toLowerCase() === address.toLowerCase()) ||
      !Number.isInteger(decimals) || Number(decimals) < 0 || Number(decimals) > 36) {
      throw new Error("Token decimals policy must contain valid decimals only for allowlisted tokens.");
    }
    tokenDecimalsByAddress[getAddress(address).toLowerCase()] = Number(decimals);
  }
  if (tokenAddresses.some((token) => tokenDecimalsByAddress[token.toLowerCase()] === undefined)) {
    throw new Error("Every allowlisted token requires an explicit token-decimals value.");
  }
  if (typeof senderJson !== "object" || senderJson === null || Array.isArray(senderJson)) {
    throw new Error("TREEBOT_DEPOSIT_SENDER_MAP_JSON must map sender addresses to account IDs.");
  }
  const senderAccountMap: Record<string, string> = {};
  for (const [address, accountId] of Object.entries(senderJson as Record<string, unknown>)) {
    if (!isAddress(address) || typeof accountId !== "string" || !accountId.trim() || accountId.length > 200) {
      throw new Error("Sender mapping contains an invalid address or account ID.");
    }
    senderAccountMap[getAddress(address).toLowerCase()] = accountId.trim();
  }
  if (!Object.keys(senderAccountMap).length) throw new Error("At least one sender-to-account mapping is required.");

  const startBlockText = required(env, "TREEBOT_DEPOSIT_START_BLOCK");
  if (!/^(0|[1-9][0-9]*)$/.test(startBlockText)) throw new Error("TREEBOT_DEPOSIT_START_BLOCK must be a non-negative integer.");
  const alertWebhookUrl = httpsOrLocalUrl(required(env, "TREEBOT_DEPOSIT_ALERT_WEBHOOK"), "TREEBOT_DEPOSIT_ALERT_WEBHOOK");
  if (new URL(alertWebhookUrl).protocol !== "https:") throw new Error("TREEBOT_DEPOSIT_ALERT_WEBHOOK must use HTTPS.");
  const confirmations = boundedInteger(env.TREEBOT_DEPOSIT_CONFIRMATIONS, 64, "TREEBOT_DEPOSIT_CONFIRMATIONS", 1, 10_000);
  const maxBlockRange = boundedInteger(env.TREEBOT_DEPOSIT_MAX_BLOCK_RANGE, 100, "TREEBOT_DEPOSIT_MAX_BLOCK_RANGE", 1, 2_000);
  const pollIntervalMs = boundedInteger(env.TREEBOT_DEPOSIT_POLL_INTERVAL_MS, 10_000, "TREEBOT_DEPOSIT_POLL_INTERVAL_MS", 1_000, 60_000);
  const stalledAfterMs = boundedInteger(env.TREEBOT_DEPOSIT_STALL_AFTER_MS, 120_000, "TREEBOT_DEPOSIT_STALL_AFTER_MS", 30_000, 3_600_000);
  if (stalledAfterMs <= pollIntervalMs) throw new Error("TREEBOT_DEPOSIT_STALL_AFTER_MS must exceed the polling interval.");

  return { workerKey, primaryRpcUrl, fallbackRpcUrl, vaultAddress: getAddress(vault), tokenAddresses,
    tokenDecimalsByAddress, senderAccountMap, startBlock: BigInt(startBlockText), confirmations,
    maxBlockRange, pollIntervalMs, stalledAfterMs, alertWebhookUrl };
}

/** Hard release gate. The code constant intentionally remains false until independent review and explicit activation. */
export function assertDepositWorkerActivation(env: Record<string, string | undefined>): void {
  if (env.TREEBOT_DEPOSITS_ENABLED !== "true") throw new Error("Deposit worker is disabled; set TREEBOT_DEPOSITS_ENABLED only after release prerequisites are approved.");
  if (!DEPOSIT_FEATURE_AVAILABLE) throw new Error("Deposit crediting is hard-disabled in this build pending independent security review and network verification.");
  const config = loadConfig(env);
  if (!config.depositsEnabled || !config.depositsOperatorApproved || !config.depositsSecurityReviewed || !config.depositsNetworkVerified || !config.depositAlertWebhook.trim()) {
    throw new Error("Deposit worker activation prerequisites are incomplete.");
  }
}

export async function assertRpcProviderAgreement(
  primary: DepositRangeReader,
  fallback: DepositRangeReader,
  confirmations: number,
  maxHeadLagBlocks = 2_000n,
): Promise<bigint> {
  const [primaryChainId, fallbackChainId] = await Promise.all([primary.getChainId(), fallback.getChainId()]);
  if (primaryChainId !== 137 || fallbackChainId !== 137) throw new Error("RPC providers disagree with the configured Polygon chain ID 137.");
  const [primaryHead, fallbackHead] = await Promise.all([primary.getBlockNumber(), fallback.getBlockNumber()]);
  const difference = primaryHead >= fallbackHead ? primaryHead - fallbackHead : fallbackHead - primaryHead;
  if (difference > maxHeadLagBlocks) throw new Error("RPC providers disagree on finalized head height.");
  const finalizedHead = (primaryHead < fallbackHead ? primaryHead : fallbackHead) - BigInt(confirmations) + 1n;
  if (finalizedHead < 0n) throw new Error("Polygon has not reached the configured confirmation threshold yet.");
  const [primaryBlock, fallbackBlock] = await Promise.all([
    primary.getBlock({ blockNumber: finalizedHead }),
    fallback.getBlock({ blockNumber: finalizedHead }),
  ]);
  if (primaryBlock.number !== finalizedHead || fallbackBlock.number !== finalizedHead ||
    primaryBlock.hash.toLowerCase() !== fallbackBlock.hash.toLowerCase()) {
    throw new Error("RPC providers disagree on the canonical hash at the finalized block.");
  }
  return finalizedHead;
}

type WorkerStatus = "starting" | "running" | "degraded" | "stopped" | "disabled";
type AlertType = "rpc_error" | "rpc_disagreement" | "scanner_stalled" | "uncredited_deposit" | "financial_incident" | "alert_delivery_failed" | "configuration_error" | "database_error" | "cost_basis_pending";

async function heartbeat(pool: Pool, input: {
  workerKey: string; status: WorkerStatus; lastSuccess: boolean; lastScannedBlock?: string;
  consecutiveErrors: number; lastError: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO execution_worker_heartbeats(worker_key,worker_type,status,last_heartbeat_at,last_success_at,last_scanned_block,consecutive_errors,last_error,updated_at)
     VALUES($1,'deposit',$2,NOW(),CASE WHEN $3 THEN NOW() ELSE NULL END,$4,$5,$6,NOW())
     ON CONFLICT(worker_key) DO UPDATE SET status=EXCLUDED.status,last_heartbeat_at=NOW(),
       last_success_at=COALESCE(EXCLUDED.last_success_at,execution_worker_heartbeats.last_success_at),
       last_scanned_block=COALESCE(EXCLUDED.last_scanned_block,execution_worker_heartbeats.last_scanned_block),
       consecutive_errors=EXCLUDED.consecutive_errors,last_error=EXCLUDED.last_error,updated_at=NOW()`,
    [input.workerKey,input.status,input.lastSuccess,input.lastScannedBlock??null,input.consecutiveErrors,input.lastError],
  );
}

export function shouldNotifyDepositAlert(
  prior: { resolvedAt: Date | string | null; lastNotifiedAt: Date | string | null; severity: "warning" | "critical" } | null,
  severity: "warning" | "critical",
  now = Date.now(),
  repeatIntervalMs = 15 * 60_000,
): boolean {
  if (!Number.isFinite(now) || !Number.isFinite(repeatIntervalMs) || repeatIntervalMs < 0) {
    throw new Error("Alert notification timing must be finite and non-negative.");
  }
  if (!prior || prior.resolvedAt !== null) return true;
  // Severity escalation must page immediately instead of waiting for the warning throttle.
  if (severity === "critical" && prior.severity !== "critical") return true;
  if (prior.lastNotifiedAt === null) return true;
  const lastNotified = new Date(prior.lastNotifiedAt).getTime();
  if (!Number.isFinite(lastNotified)) return true;
  return now - lastNotified >= repeatIntervalMs;
}

async function upsertAlert(pool: Pool, settings: DepositWorkerSettings, input: {
  type: AlertType; severity: "warning" | "critical"; dedupeKey: string; details: Record<string, unknown>;
}): Promise<boolean> {
  const existing = await pool.query("SELECT resolved_at,last_notified_at,severity FROM execution_worker_alerts WHERE dedupe_key=$1",[input.dedupeKey]);
  const prior = existing.rows[0];
  const shouldNotify = shouldNotifyDepositAlert(
    prior ? {
      resolvedAt: prior.resolved_at as Date | string | null,
      lastNotifiedAt: prior.last_notified_at as Date | string | null,
      severity: prior.severity as "warning" | "critical",
    } : null,
    input.severity,
    Date.now(),
  );
  await pool.query(
    `INSERT INTO execution_worker_alerts(worker_key,alert_type,severity,dedupe_key,details,last_notified_at)
     VALUES($1,$2,$3,$4,$5::jsonb,CASE WHEN $6 THEN NOW() ELSE NULL END)
     ON CONFLICT(dedupe_key) DO UPDATE SET severity=EXCLUDED.severity,details=EXCLUDED.details,last_seen_at=NOW(),
       resolved_at=NULL,last_notified_at=CASE WHEN $6 THEN NOW() ELSE execution_worker_alerts.last_notified_at END`,
    [settings.workerKey,input.type,input.severity,input.dedupeKey,JSON.stringify(input.details),shouldNotify],
  );
  return shouldNotify;
}

async function resolveAlert(pool: Pool, workerKey: string, type: AlertType): Promise<void> {
  await pool.query("UPDATE execution_worker_alerts SET resolved_at=NOW(),last_seen_at=NOW() WHERE worker_key=$1 AND alert_type=$2 AND resolved_at IS NULL",[workerKey,type]);
}

async function deliverAlert(settings: DepositWorkerSettings, input: {type:AlertType;severity:"warning"|"critical";details:Record<string,unknown>}): Promise<void> {
  const response = await fetch(settings.alertWebhookUrl,{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({source:"TreeBot deposit worker",workerKey:settings.workerKey,type:input.type,severity:input.severity,occurredAt:new Date().toISOString(),details:input.details}),
    signal:AbortSignal.timeout(5_000),
  });
  if(!response.ok)throw new Error("Deposit alert webhook returned HTTP "+response.status+".");
}

async function alertIfNeeded(pool:Pool,settings:DepositWorkerSettings,input:{type:AlertType;severity:"warning"|"critical";details:Record<string,unknown>}):Promise<void>{
  const shouldNotify=await upsertAlert(pool,settings,{...input,dedupeKey:settings.workerKey+":"+input.type});
  if(shouldNotify){
    try{await deliverAlert(settings,input);}
    catch(error){
      const message=(error instanceof Error?error.message:"Alert delivery failed.").slice(0,500);
      await upsertAlert(pool,settings,{type:"alert_delivery_failed",severity:"critical",dedupeKey:settings.workerKey+":alert_delivery_failed",details:{cause:message,alertType:input.type}});
    }
  }
}

export async function runDepositWorker(input:{
  pool:Pool;settings:DepositWorkerSettings;scanner:PolygonDepositScanner;
  primary:DepositRangeReader;fallback:DepositRangeReader;shouldStop:()=>boolean;
  sleep?:(milliseconds:number)=>Promise<void>;
}):Promise<void>{
  const pause=input.sleep??((milliseconds:number)=>new Promise<void>((resolve)=>setTimeout(resolve,milliseconds)));
  let consecutiveErrors=0;
  let lastSuccessAt=Date.now();
  let lastScannedBlock:string|undefined;
  await heartbeat(input.pool,{workerKey:input.settings.workerKey,status:"starting",lastSuccess:false,consecutiveErrors,lastError:null});
  while(!input.shouldStop()){
    try{
      await assertRpcProviderAgreement(input.primary,input.fallback,input.settings.confirmations,0n);
      const result=await input.scanner.scanOnce();
      const from=BigInt(result.fromBlock),to=BigInt(result.toBlock);
      if(to>=from&&to>=0n)lastScannedBlock=to.toString();
      consecutiveErrors=0;
      lastSuccessAt=Date.now();
      await heartbeat(input.pool,{workerKey:input.settings.workerKey,status:"running",lastSuccess:true,lastScannedBlock,consecutiveErrors,lastError:null});
      await resolveAlert(input.pool,input.settings.workerKey,"rpc_error");
      await resolveAlert(input.pool,input.settings.workerKey,"rpc_disagreement");
      await resolveAlert(input.pool,input.settings.workerKey,"scanner_stalled");

      const uncredited=await input.pool.query(
        "SELECT COUNT(*)::text AS count FROM execution_deposit_lifecycle WHERE chain_id=137 AND watcher_key=$1 AND status='confirmed' AND credited_event_key IS NULL",
        [input.settings.workerKey],
      );
      const uncreditedCount=Number(uncredited.rows[0]?.count??0);
      if(uncreditedCount>0)await alertIfNeeded(input.pool,input.settings,{type:"uncredited_deposit",severity:"critical",details:{count:uncreditedCount,watcherKey:input.settings.workerKey}});
      else await resolveAlert(input.pool,input.settings.workerKey,"uncredited_deposit");

      const incidents=await input.pool.query("SELECT COUNT(*)::text AS count FROM execution_financial_incidents WHERE status IN('open','investigating')");
      const incidentCount=Number(incidents.rows[0]?.count??0);
      if(incidentCount>0)await alertIfNeeded(input.pool,input.settings,{type:"financial_incident",severity:"critical",details:{count:incidentCount}});
      else await resolveAlert(input.pool,input.settings.workerKey,"financial_incident");

      const pendingAccounting=await input.pool.query(
        "SELECT COUNT(*)::text AS count FROM execution_trade_accounting WHERE accounting_status IN('pending','reconciliation_required')",
      );
      const pendingAccountingCount=Number(pendingAccounting.rows[0]?.count??0);
      if(pendingAccountingCount>0)await alertIfNeeded(input.pool,input.settings,{type:"cost_basis_pending",severity:"warning",details:{count:pendingAccountingCount}});
      else await resolveAlert(input.pool,input.settings.workerKey,"cost_basis_pending");
    }catch(error){
      consecutiveErrors+=1;
      const message=(error instanceof Error?error.message:"Unknown deposit worker error.").slice(0,1000);
      const disagreement=/disagree|canonical hash|chain ID/i.test(message);
      const databaseError=/postgres|database|relation .* does not exist|connection refused|ECONN/i.test(message);
      const type:AlertType=disagreement?"rpc_disagreement":databaseError?"database_error":"rpc_error";
      await heartbeat(input.pool,{workerKey:input.settings.workerKey,status:consecutiveErrors>=3?"degraded":"running",lastSuccess:false,lastScannedBlock,consecutiveErrors,lastError:message});
      await alertIfNeeded(input.pool,input.settings,{type,severity:consecutiveErrors>=3?"critical":"warning",details:{error:message,consecutiveErrors}});
      if(Date.now()-lastSuccessAt>=input.settings.stalledAfterMs){
        await alertIfNeeded(input.pool,input.settings,{type:"scanner_stalled",severity:"critical",details:{lastSuccessfulScanAt:new Date(lastSuccessAt).toISOString(),consecutiveErrors}});
      }
    }
    if(!input.shouldStop())await pause(Math.min(input.settings.pollIntervalMs*2**Math.min(consecutiveErrors,5),60_000));
  }
  await heartbeat(input.pool,{workerKey:input.settings.workerKey,status:"stopped",lastSuccess:false,lastScannedBlock,consecutiveErrors,lastError:null});
}
