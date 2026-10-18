import { createPublicClient, getAddress, http, isAddress, type Address, type PublicClient } from "viem";
import { polygon } from "viem/chains";
import type { Pool } from "pg";
import { PostgresExecutionStore } from "./postgres";
import { verifyChainlinkAssetValuation, type ValuationReader } from "./valuation-verifier";

const chainlinkAbi=[
  {type:"function",name:"decimals",stateMutability:"view",inputs:[],outputs:[{name:"",type:"uint8"}]},
  {type:"function",name:"latestRoundData",stateMutability:"view",inputs:[],outputs:[
    {name:"roundId",type:"uint80"},{name:"answer",type:"int256"},{name:"startedAt",type:"uint256"},
    {name:"updatedAt",type:"uint256"},{name:"answeredInRound",type:"uint80"},
  ]},
] as const;

export interface ValuationWorkerSettings {
  workerKey:string;
  primaryRpcUrl:string;
  fallbackRpcUrl:string;
  quoteToken:Address;
  quoteFeedAddress:Address;
  quoteTokenDecimals:number;
  feedByAddress:Map<string,Address>;
  tokenDecimalsByAddress:Map<string,number>;
  requiredConfirmations:number;
  maxStalenessSeconds:number;
  pollIntervalMs:number;
  alertWebhookUrl:string;
  trustedValuationSourcesJson:string;
}
function required(env:Record<string,string|undefined>,key:string):string{
  const value=env[key]?.trim();if(!value)throw new Error(`${key} is required for the valuation worker.`);return value;
}
function boundedInt(raw:string|undefined,fallback:number,min:number,max:number,label:string):number{
  const value=raw===undefined||raw===""?fallback:Number(raw);
  if(!Number.isInteger(value)||value<min||value>max)throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  return value;
}
function httpsUrl(value:string,label:string):string{
  let url:URL;try{url=new URL(value);}catch{throw new Error(`${label} must be a valid URL.`);}
  if(url.protocol!=="https:"||url.username||url.password)throw new Error(`${label} must use HTTPS without embedded credentials.`);
  return url.toString();
}
function parseAddressMap(raw:string,label:string):Map<string,Address>{
  let value:unknown;try{value=JSON.parse(raw);}catch{throw new Error(`${label} must be valid JSON.`);}
  if(typeof value!=="object"||value===null||Array.isArray(value))throw new Error(`${label} must be a JSON object.`);
  const result=new Map<string,Address>();
  for(const [key,feed] of Object.entries(value)){
    if(!isAddress(key)||typeof feed!=="string"||!isAddress(feed))throw new Error(`${label} must map token addresses to feed addresses.`);
    const normalized=getAddress(key).toLowerCase();
    if(result.has(normalized))throw new Error(`${label} contains a duplicate token address.`);
    result.set(normalized,getAddress(feed));
  }
  if(result.size===0)throw new Error(`${label} must contain at least one token/feed mapping.`);
  return result;
}
function parseDecimalsMap(raw:string,label:string):Map<string,number>{
  let value:unknown;try{value=JSON.parse(raw);}catch{throw new Error(`${label} must be valid JSON.`);}
  if(typeof value!=="object"||value===null||Array.isArray(value))throw new Error(`${label} must be a JSON object.`);
  const result=new Map<string,number>();
  for(const [key,decimals] of Object.entries(value)){
    if(!isAddress(key)||typeof decimals!=="number"||!Number.isInteger(decimals)||decimals<0||decimals>36)throw new Error(`${label} contains an invalid token-decimals entry.`);
    result.set(getAddress(key).toLowerCase(),decimals);
  }
  return result;
}
export function parseValuationWorkerSettings(env:Record<string,string|undefined>):ValuationWorkerSettings{
  const workerKey=env.TREEBOT_VALUATION_WORKER_KEY?.trim()||"polygon-valuation-1";
  if(!/^[a-zA-Z0-9._:-]{1,100}$/.test(workerKey))throw new Error("TREEBOT_VALUATION_WORKER_KEY is invalid.");
  const primaryRpcUrl=httpsUrl(required(env,"POLYGON_RPC_URL"),"POLYGON_RPC_URL");
  const fallbackRpcUrl=httpsUrl(required(env,"POLYGON_RPC_FALLBACK_URL"),"POLYGON_RPC_FALLBACK_URL");
  if(primaryRpcUrl===fallbackRpcUrl)throw new Error("Valuation worker requires two distinct Polygon RPC endpoints.");
  const quoteToken=required(env,"TREEBOT_ACCOUNTING_QUOTE_TOKEN");
  const quoteFeedAddress=required(env,"TREEBOT_QUOTE_TOKEN_FEED_ADDRESS");
  if(!isAddress(quoteToken)||!isAddress(quoteFeedAddress))throw new Error("Canonical quote-token and quote-feed addresses must be valid.");
  let trusted:unknown;try{trusted=JSON.parse(env.TREEBOT_TRUSTED_VALUATION_SOURCES_JSON??"[]");}catch{throw new Error("TREEBOT_TRUSTED_VALUATION_SOURCES_JSON must be valid JSON.");}
  if(!Array.isArray(trusted)||!trusted.includes("chainlink_polygon"))throw new Error("Trusted valuation sources must explicitly include chainlink_polygon.");
  const feedByAddress=parseAddressMap(required(env,"TREEBOT_PRICE_FEEDS_JSON"),"TREEBOT_PRICE_FEEDS_JSON");
  const tokenDecimalsByAddress=parseDecimalsMap(env.TREEBOT_TOKEN_DECIMALS_JSON??env.TREEBOT_DEPOSIT_TOKEN_DECIMALS_JSON??"{}","TREEBOT_TOKEN_DECIMALS_JSON");
  return {
    workerKey,primaryRpcUrl,fallbackRpcUrl,quoteToken:getAddress(quoteToken),quoteFeedAddress:getAddress(quoteFeedAddress),
    quoteTokenDecimals:boundedInt(env.TREEBOT_QUOTE_TOKEN_DECIMALS,6,0,36,"TREEBOT_QUOTE_TOKEN_DECIMALS"),
    feedByAddress,tokenDecimalsByAddress,
    requiredConfirmations:boundedInt(env.TREEBOT_VALUATION_CONFIRMATIONS,64,64,10_000,"TREEBOT_VALUATION_CONFIRMATIONS"),
    maxStalenessSeconds:boundedInt(env.TREEBOT_VALUATION_MAX_STALENESS_SECONDS,300,30,86_400,"TREEBOT_VALUATION_MAX_STALENESS_SECONDS"),
    pollIntervalMs:boundedInt(env.TREEBOT_VALUATION_POLL_INTERVAL_MS,30_000,1_000,300_000,"TREEBOT_VALUATION_POLL_INTERVAL_MS"),
    alertWebhookUrl:httpsUrl(required(env,"TREEBOT_VALUATION_ALERT_WEBHOOK"),"TREEBOT_VALUATION_ALERT_WEBHOOK"),
    trustedValuationSourcesJson:JSON.stringify(trusted),
  };
}
export function assertValuationWorkerActivation(env:Record<string,string|undefined>):void{
  if(env.TREEBOT_VALUATIONS_ENABLED!=="true")throw new Error("Valuation worker is disabled; set TREEBOT_VALUATIONS_ENABLED=true only after reviewing feed mappings and operator controls.");
  for(const key of ["TREEBOT_VALUATIONS_OPERATOR_APPROVED","TREEBOT_VALUATIONS_SECURITY_REVIEWED","TREEBOT_VALUATIONS_NETWORK_VERIFIED"]){
    if(env[key]!=="true")throw new Error(`${key}=true is required before valuation worker activation.`);
  }
}
export function createViemValuationReader(client:PublicClient):ValuationReader{
  return {
    getChainId:()=>client.getChainId(),
    getBlockNumber:()=>client.getBlockNumber(),
    getBlock:async({blockNumber})=>{
      const block=await client.getBlock({blockNumber});
      if(!block.hash||!block.parentHash)throw new Error("Polygon block response is missing canonical hashes.");
      return {number:block.number,hash:block.hash,parentHash:block.parentHash,timestamp:block.timestamp};
    },
    readFeedDecimals:async({address,blockNumber})=>Number(await client.readContract({address,abi:chainlinkAbi,functionName:"decimals",blockNumber})),
    readLatestRoundData:async({address,blockNumber})=>{
      const result=await client.readContract({address,abi:chainlinkAbi,functionName:"latestRoundData",blockNumber});
      return {roundId:result[0],answer:result[1],updatedAt:result[3],answeredInRound:result[4]};
    },
  };
}
type AlertType="valuation_stale"|"rpc_error"|"database_error"|"alert_delivery_failed";
async function upsertAlert(pool:Pool,settings:ValuationWorkerSettings,type:AlertType,severity:"warning"|"critical",details:Record<string,unknown>):Promise<void>{
  const dedupeKey=settings.workerKey+":"+type;
  const prior=await pool.query("SELECT resolved_at,last_notified_at,severity FROM execution_worker_alerts WHERE dedupe_key=$1",[dedupeKey]);
  const row=prior.rows[0];
  const notify=!row||row.resolved_at!==null||(severity==="critical"&&row.severity!=="critical")||!row.last_notified_at||
    Date.now()-new Date(row.last_notified_at).getTime()>=15*60_000;
  await pool.query(
    `INSERT INTO execution_worker_alerts(worker_key,dedupe_key,alert_type,severity,details,last_seen_at,last_notified_at)
     VALUES($1,$2,$3,$4,$5::jsonb,NOW(),CASE WHEN $6 THEN NOW() ELSE NULL END)
     ON CONFLICT(dedupe_key) DO UPDATE SET severity=EXCLUDED.severity,details=EXCLUDED.details,last_seen_at=NOW(),resolved_at=NULL,
       last_notified_at=CASE WHEN $6 THEN NOW() ELSE execution_worker_alerts.last_notified_at END`,
    [settings.workerKey,dedupeKey,type,severity,JSON.stringify(details),notify],
  );
  if(!notify)return;
  try{
    const response=await fetch(settings.alertWebhookUrl,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({source:"treebot-valuation-worker",type,severity,details,at:new Date().toISOString()})});
    if(!response.ok)throw new Error(`Alert endpoint returned HTTP ${response.status}.`);
  }catch(error){
    await pool.query(
      `INSERT INTO execution_worker_alerts(worker_key,dedupe_key,alert_type,severity,details,last_seen_at,last_notified_at)
       VALUES($1,$2,'alert_delivery_failed','critical',$3::jsonb,NOW(),NOW())
       ON CONFLICT(dedupe_key) DO UPDATE SET severity='critical',details=EXCLUDED.details,last_seen_at=NOW(),resolved_at=NULL,last_notified_at=NOW()`,
      [settings.workerKey,settings.workerKey+":alert_delivery_failed",JSON.stringify({cause:error instanceof Error?error.message:"Unknown alert delivery failure"})],
    );
  }
}
async function resolveAlert(pool:Pool,workerKey:string,type:AlertType):Promise<void>{
  await pool.query("UPDATE execution_worker_alerts SET resolved_at=COALESCE(resolved_at,NOW()),last_seen_at=NOW() WHERE worker_key=$1 AND alert_type=$2 AND resolved_at IS NULL",[workerKey,type]);
}
async function heartbeat(pool:Pool,workerKey:string,status:"starting"|"running"|"degraded"|"stopped",lastError:string|null,errors:number,success:boolean):Promise<void>{
  await pool.query(
    `INSERT INTO execution_worker_heartbeats(worker_key,worker_type,status,last_heartbeat_at,last_success_at,last_error,consecutive_errors,updated_at)
     VALUES($1,'valuation',$2,NOW(),CASE WHEN $5 THEN NOW() ELSE NULL END,$3,$4,NOW())
     ON CONFLICT(worker_key) DO UPDATE SET worker_type='valuation',status=EXCLUDED.status,last_heartbeat_at=NOW(),
       last_success_at=CASE WHEN $5 THEN NOW() ELSE execution_worker_heartbeats.last_success_at END,last_error=EXCLUDED.last_error,
       consecutive_errors=EXCLUDED.consecutive_errors,updated_at=NOW()`,
    [workerKey,status,lastError,errors,success],
  );
}
export async function runValuationWorker(input:{
  pool:Pool;settings:ValuationWorkerSettings;primary:ValuationReader;fallback:ValuationReader;
  shouldStop:()=>boolean;sleep:(ms:number)=>Promise<void>;
}):Promise<void>{
  let consecutiveErrors=0;
  await heartbeat(input.pool,input.settings.workerKey,"starting",null,0,false);
  try{
    while(!input.shouldStop()){
      try{
        const assets=await input.pool.query(
          "SELECT DISTINCT account_id,LOWER(asset_address) AS asset_address FROM execution_position_inventory WHERE chain_id=137 AND quantity_base_units>0 AND LOWER(asset_address)<>LOWER($1) AND LOWER(asset_address)<>'0x0000000000000000000000000000000000000000' ORDER BY account_id,LOWER(asset_address)",
          [input.settings.quoteToken],
        );
        const failures:Array<{accountId:string;assetAddress:string;reason:string}>=[];
        const store=new PostgresExecutionStore(input.pool,input.settings.quoteToken,input.settings.trustedValuationSourcesJson);
        for(const row of assets.rows){
          const accountId=String(row.account_id),assetAddress=String(row.asset_address).toLowerCase();
          const feed=input.settings.feedByAddress.get(assetAddress);
          const decimals=input.settings.tokenDecimalsByAddress.get(assetAddress);
          if(!feed||decimals===undefined){
            failures.push({accountId,assetAddress,reason:"No approved Chainlink feed or token-decimals mapping is configured."});
            continue;
          }
          try{
            const proof=await verifyChainlinkAssetValuation(input.primary,input.fallback,{
              accountId,assetAddress:getAddress(assetAddress),quoteAssetAddress:input.settings.quoteToken,
              assetFeedAddress:feed,quoteFeedAddress:input.settings.quoteFeedAddress,tokenDecimals:decimals,
              quoteTokenDecimals:input.settings.quoteTokenDecimals,requiredConfirmations:input.settings.requiredConfirmations,
              maxStalenessSeconds:input.settings.maxStalenessSeconds,
            });
            await store.recordAssetValuation(proof);
          }catch(error){
            failures.push({accountId,assetAddress,reason:error instanceof Error?error.message:"Unknown valuation failure"});
          }
        }
        if(failures.length){
          consecutiveErrors++;
          const details={count:failures.length,assets:failures.slice(0,20)};
          await heartbeat(input.pool,input.settings.workerKey,"degraded",`${failures.length} asset valuation(s) failed.`,consecutiveErrors,false);
          await upsertAlert(input.pool,input.settings,"valuation_stale",consecutiveErrors>=3?"critical":"warning",details);
        }else{
          consecutiveErrors=0;
          await heartbeat(input.pool,input.settings.workerKey,"running",null,0,true);
          await resolveAlert(input.pool,input.settings.workerKey,"valuation_stale");
          await resolveAlert(input.pool,input.settings.workerKey,"rpc_error");
          await resolveAlert(input.pool,input.settings.workerKey,"database_error");
        }
      }catch(error){
        consecutiveErrors++;
        const message=error instanceof Error?error.message:"Unknown valuation worker failure";
        await heartbeat(input.pool,input.settings.workerKey,"degraded",message,consecutiveErrors,false);
        await upsertAlert(input.pool,input.settings,"rpc_error",consecutiveErrors>=3?"critical":"warning",{cause:message});
      }
      if(!input.shouldStop())await input.sleep(input.settings.pollIntervalMs);
    }
  }finally{
    await heartbeat(input.pool,input.settings.workerKey,"stopped",null,consecutiveErrors,false);
  }
}
export function createViemPublicClient(rpcUrl:string):PublicClient{
  return createPublicClient({chain:polygon,transport:http(rpcUrl,{timeout:10_000,retryCount:2,retryDelay:500})}) as PublicClient;
}
