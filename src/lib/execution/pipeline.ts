import { isAddress, getAddress, type Hash } from "viem";
import type { ValidatedSwapQuote, ZeroExPolygonQuoteAdapter } from "./zero-ex";
import type { PolygonExecutionReadClient, TransactionSimulation, ReceiptSettlement } from "./evm-client";
import type { PostgresExecutionStore } from "./postgres";
import { authorizeExecution, assertLiveExecutionUnavailable, type ExecutionAuthorization } from "./authorization";

export interface ExecutionRiskState {
  emergencyStop:boolean; tradingEnabled:boolean; maximumSlippageBps:number;
  allowedTokens:readonly string[]; allowedTargets:readonly string[];
}
export interface ExecutionIntentRequest {
  id:string; idempotencyKey:string; owner:string; sellToken:string; buyToken:string; sellAmount:string;
  slippageBps:number; authorization:ExecutionAuthorization;
}
export interface PreparedExecution {
  quote:ValidatedSwapQuote; simulation:TransactionSimulation; recordId:string; status:"prepared"|"already-recorded";
}
export interface ExecutionDependencies {
  quotes:ZeroExPolygonQuoteAdapter; chain:PolygonExecutionReadClient; store:PostgresExecutionStore;
  loadRiskState:()=>Promise<ExecutionRiskState>;
  /** Only a separately audited smart-account adapter may be supplied. */
  submitAuthorized?:(simulation:TransactionSimulation,authorization:ExecutionAuthorization)=>Promise<{hash:Hash;nonce:number}>;
  now?:()=>number;
}
export class PolygonExecutionPipeline {
  constructor(private readonly d:ExecutionDependencies){}
  async prepare(request:ExecutionIntentRequest):Promise<PreparedExecution>{
    if(![request.owner,request.sellToken,request.buyToken].every(isAddress))throw new Error("Invalid execution address.");
    const owner=getAddress(request.owner),sellToken=getAddress(request.sellToken),buyToken=getAddress(request.buyToken);
    const risk=await this.d.loadRiskState();
    if(!risk.tradingEnabled||risk.emergencyStop)throw new Error("Execution is paused by the risk control.");
    if(!Number.isInteger(request.slippageBps)||request.slippageBps<0||request.slippageBps>risk.maximumSlippageBps)throw new Error("Requested slippage exceeds current risk policy.");
    if(!risk.allowedTokens.some(v=>isAddress(v)&&getAddress(v)===sellToken)||!risk.allowedTokens.some(v=>isAddress(v)&&getAddress(v)===buyToken))throw new Error("Token not allowed by current risk policy.");
    const quote=await this.d.quotes.getFirmQuote({chainId:137,sellToken,buyToken,sellAmount:request.sellAmount,taker:owner,slippageBps:request.slippageBps});
    if(!risk.allowedTargets.some(v=>isAddress(v)&&getAddress(v)===quote.transaction.to))throw new Error("Quote target not allowed by current risk policy.");
    const auth=authorizeExecution(request.authorization,{chainId:137,owner,sellToken,buyToken,sellAmount:request.sellAmount,transactionTarget:quote.transaction.to,now:(this.d.now??Date.now)()});
    if(!auth.allowed)throw new Error(`Execution authorization rejected: ${auth.reason}`);
    const tx={chainId:quote.chainId,from:owner,to:quote.transaction.to,data:quote.transaction.data,
      value:quote.transaction.value.toString(),gas:quote.transaction.gas?.toString()??null,gasPrice:quote.transaction.gasPrice?.toString()??null};
    const storedQuote={...quote,sellAmount:quote.sellAmount.toString(),buyAmount:quote.buyAmount.toString(),minBuyAmount:quote.minBuyAmount.toString(),
      transaction:{...quote.transaction,value:quote.transaction.value.toString(),gas:quote.transaction.gas?.toString()??null,gasPrice:quote.transaction.gasPrice?.toString()??null}};
    const reserved=await this.d.store.createOrGetIntent({id:request.id,idempotencyKey:request.idempotencyKey,walletAddress:owner,
      sellToken,buyToken,sellAmount:request.sellAmount,quote:storedQuote,authorizationId:request.authorization.id,
      riskChecks:{tradingEnabled:risk.tradingEnabled,emergencyStop:risk.emergencyStop,maximumSlippageBps:risk.maximumSlippageBps,checkedAt:(this.d.now??Date.now)()},
      preparedTransaction:tx});
    // On idempotent replay, only return an existing settled/broadcast record after lookup;
    // do not create a fresh quote that could be submitted twice.
    if(!reserved.created){
      if(reserved.record.status!=="prepared")throw new Error(`Idempotency key already exists with status ${reserved.record.status}; reconcile existing hash before any next action.`);
      return {quote,simulation:await this.d.chain.simulateExactSwap(quote,owner),recordId:reserved.record.id,status:"already-recorded"};
    }
    try{return {quote,simulation:await this.d.chain.simulateExactSwap(quote,owner),recordId:reserved.record.id,status:"prepared"};}
    catch(error){throw new Error(`Transaction simulation failed; intent ${reserved.record.id} retained and not submitted: ${error instanceof Error?error.message:"unknown error"}`);}
  }
  async submitPrepared(prepared:PreparedExecution,request:ExecutionIntentRequest):Promise<{hash:Hash;nonce:number}>{
    const risk=await this.d.loadRiskState();
    if(!risk.tradingEnabled||risk.emergencyStop)throw new Error("Submission blocked: trading disabled or emergency stop active.");
    if(!this.d.submitAuthorized)return assertLiveExecutionUnavailable();
    const auth=authorizeExecution(request.authorization,{chainId:137,owner:request.owner,sellToken:request.sellToken,buyToken:request.buyToken,
      sellAmount:request.sellAmount,transactionTarget:prepared.quote.transaction.to,now:(this.d.now??Date.now)()});
    if(!auth.allowed)throw new Error(`Submission authorization rejected: ${auth.reason}`);
    if(prepared.status!=="prepared")throw new Error("Only a newly prepared intent can be submitted; idempotent replay is not resubmittable.");
    if(prepared.quote.slippageBps>risk.maximumSlippageBps||!risk.allowedTargets.some(v=>isAddress(v)&&getAddress(v)===prepared.quote.transaction.to))throw new Error("Submission blocked by current target/slippage policy.");
    // Last-moment simulation is required after the durable reservation and the live gates.
    const freshRisk=await this.d.loadRiskState();
    if(!freshRisk.tradingEnabled||freshRisk.emergencyStop)throw new Error("Submission blocked by changed risk control.");
    const freshAuth=authorizeExecution(request.authorization,{chainId:137,owner:request.owner,sellToken:request.sellToken,buyToken:request.buyToken,
      sellAmount:request.sellAmount,transactionTarget:prepared.quote.transaction.to,now:(this.d.now??Date.now)()});
    if(!freshAuth.allowed)throw new Error(`Submission authorization rejected: ${freshAuth.reason}`);
    const freshSimulation=await this.d.chain.simulateExactSwap(prepared.quote,request.owner);
    const result=await this.d.submitAuthorized(freshSimulation,request.authorization);
    try{await this.d.store.recordBroadcast(prepared.recordId,"audited-smart-account-adapter",result.hash,result.nonce);}
    catch(error){
      await this.d.store.recordSubmissionUnknown(prepared.recordId,`Broadcast returned hash but persistence failed: ${error instanceof Error?error.message:"unknown persistence error"}; hash=${result.hash}`);
      throw new Error("Submission persistence is indeterminate. Do not retry; reconcile chain state.");
    }
    return result;
  }
  async reconcileReceipt(recordId:string,settlement:ReceiptSettlement,actualSellAmount:string,actualBuyAmount:string):Promise<void>{
    await this.d.store.recordSettlement({id:recordId,status:settlement.status,blockNumber:settlement.blockNumber.toString(),
      actualSellAmount,actualBuyAmount,gasWei:settlement.gasCostWei.toString()});
  }
}
