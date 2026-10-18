import { isAddress, getAddress, type Address, type Hash, type Hex } from "viem";
import type { ValidatedSwapQuote, ZeroExPolygonQuoteAdapter } from "./zero-ex";
import type { PolygonExecutionReadClient, TransactionSimulation, ReceiptSettlement } from "./evm-client";
import type { PostgresExecutionStore } from "./postgres";
import { authorizeExecution, assertLiveExecutionUnavailable, type ExecutionAuthorization } from "./authorization";
import { verifyTradeSettlement, type TradeSettlementReader } from "./trade-settlement-verifier";

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
  quotes: Pick<ZeroExPolygonQuoteAdapter, "getFirmQuote">;
  chain: Pick<PolygonExecutionReadClient, "simulateExactSwap"> & Partial<Pick<PolygonExecutionReadClient, "publicClient">>;
  store: Pick<PostgresExecutionStore, "createOrGetIntent" | "recordBroadcast" | "recordSubmissionUnknown" | "recordSettlement" | "getExecutionIntentForSettlement" | "recordVerifiedSettlement">;
  settlementConfirmations?: number;
  loadRiskState:()=>Promise<ExecutionRiskState>;
  /** Only a separately audited smart-account adapter may be supplied. */
  submitAuthorized?:(simulation:TransactionSimulation,authorization:ExecutionAuthorization)=>Promise<{hash:Hash;nonce:number}>;
  /** Must decode and validate the exact quote calldata using operator-reviewed route ABIs. */
  validateSwapSemantics?:(quote:ValidatedSwapQuote,authorization:ExecutionAuthorization)=>void;
  now?:()=>number;
}
export class PolygonExecutionPipeline {
  constructor(private readonly d:ExecutionDependencies){}
  async prepare(request:ExecutionIntentRequest):Promise<PreparedExecution>{
    if(![request.owner,request.sellToken,request.buyToken].every((address) => isAddress(address)))throw new Error("Invalid execution address.");
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
    if(getAddress(request.owner)!==prepared.quote.taker||getAddress(request.sellToken)!==prepared.quote.sellToken||getAddress(request.buyToken)!==prepared.quote.buyToken||BigInt(request.sellAmount)!==prepared.quote.sellAmount)throw new Error("Prepared quote does not match the requested owner, token pair, or exact input amount.");
    if(prepared.quote.slippageBps>risk.maximumSlippageBps||!risk.allowedTargets.some(v=>isAddress(v)&&getAddress(v)===prepared.quote.transaction.to))throw new Error("Submission blocked by current target/slippage policy.");
    if(!this.d.validateSwapSemantics)throw new Error("Live submission blocked: no reviewed semantic calldata validator is configured.");
    this.d.validateSwapSemantics(prepared.quote,request.authorization);
    // Last-moment simulation is required after the durable reservation and the live gates.
    const freshRisk=await this.d.loadRiskState();
    if(!freshRisk.tradingEnabled||freshRisk.emergencyStop)throw new Error("Submission blocked by changed risk control.");
    const freshAuth=authorizeExecution(request.authorization,{chainId:137,owner:request.owner,sellToken:request.sellToken,buyToken:request.buyToken,
      sellAmount:request.sellAmount,transactionTarget:prepared.quote.transaction.to,now:(this.d.now??Date.now)()});
    if(!freshAuth.allowed)throw new Error(`Submission authorization rejected: ${freshAuth.reason}`);
    const freshSimulation=await this.d.chain.simulateExactSwap(prepared.quote,request.owner);
    if(freshSimulation.chainId!==137||getAddress(freshSimulation.from)!==getAddress(request.owner)||getAddress(freshSimulation.to)!==prepared.quote.transaction.to||freshSimulation.data.toLowerCase()!==prepared.quote.transaction.data.toLowerCase()||freshSimulation.value!==prepared.quote.transaction.value)throw new Error("Fresh simulation does not match the exact authorized quote transaction.");
    const result=await this.d.submitAuthorized(freshSimulation,request.authorization);
    try{await this.d.store.recordBroadcast(prepared.recordId,"audited-smart-account-adapter",result.hash,result.nonce);}
    catch(error){
      await this.d.store.recordSubmissionUnknown(prepared.recordId,`Broadcast returned hash but persistence failed: ${error instanceof Error?error.message:"unknown persistence error"}; hash=${result.hash}`);
      throw new Error("Submission persistence is indeterminate. Do not retry; reconcile chain state.");
    }
    return result;
  }
  async reconcileReceipt(recordId:string,settlement:ReceiptSettlement):Promise<void>{
    const intent=await this.d.store.getExecutionIntentForSettlement(recordId);
    if(!intent.txHash||intent.nonce===null)throw new Error("Trade settlement cannot proceed until transaction hash and nonce are durably recorded.");
    const publicClient=this.d.chain.publicClient;
    if(!publicClient)throw new Error("Proof-bearing trade settlement requires a Polygon public client; caller-supplied receipt data is not trusted.");
    const prepared=intent.preparedTransaction;
    const target=String(prepared.to??"");
    const data=String(prepared.data??"");
    const value=prepared.value===undefined?"0":String(prepared.value);
    if(!isAddress(target)||!/^0x(?:[0-9a-fA-F]{2})*$/.test(data)||!/^(0|[1-9][0-9]*)$/.test(value)){
      throw new Error("Persisted prepared transaction is malformed; settlement remains unresolved.");
    }
    const reader:TradeSettlementReader={
      getChainId:()=>publicClient.getChainId(),
      getTransactionReceipt:async({hash})=>{
        const receipt=await publicClient.getTransactionReceipt({hash});
        return {transactionHash:receipt.transactionHash,status:receipt.status==="success"?"success":"reverted",
          blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,gasUsed:receipt.gasUsed,
          effectiveGasPrice:receipt.effectiveGasPrice,logs:receipt.logs.map((log)=>({
            address:log.address,data:log.data,topics:log.topics,logIndex:log.logIndex,
          }))};
      },
      getTransaction:async({hash})=>{
        const transaction=await publicClient.getTransaction({hash});
        return {hash:transaction.hash,from:transaction.from,to:transaction.to,input:transaction.input,value:transaction.value,nonce:transaction.nonce};
      },
      getBlockNumber:()=>publicClient.getBlockNumber(),
      getBlock:async({blockNumber})=>{
        const block=await publicClient.getBlock({blockNumber});
        if(!block.hash||!block.parentHash)throw new Error("Canonical block is missing a hash.");
        return {number:block.number,hash:block.hash,parentHash:block.parentHash};
      },
    };
    const proof=await verifyTradeSettlement(reader,{
      executionId:recordId,transactionHash:intent.txHash as Hash,nonce:intent.nonce,
      walletAddress:intent.walletAddress as Address,sellToken:intent.sellToken as Address,buyToken:intent.buyToken as Address,
      reservedSellAmountBaseUnits:intent.sellAmount,transactionTarget:target as Address,transactionData:data as Hex,
      transactionValueWei:value,requiredConfirmations:this.d.settlementConfirmations??64,
    });
    if(proof.blockNumber!==settlement.blockNumber.toString()||proof.status!==settlement.status||proof.gasWei!==settlement.gasCostWei.toString()||
      proof.transactionHash.toLowerCase()!==settlement.hash.toLowerCase()){
      throw new Error("Observed receipt summary disagrees with independently verified Polygon settlement evidence.");
    }
    await this.d.store.recordVerifiedSettlement(proof);
  }
}
