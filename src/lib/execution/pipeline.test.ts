import { describe, expect, it, vi } from "vitest";
import { PolygonExecutionPipeline } from "./pipeline";
import { assertLiveExecutionUnavailable } from "./authorization";
import type { ExecutionDependencies, ExecutionRiskState } from "./pipeline";
import type { ValidatedSwapQuote } from "./zero-ex";
import type { TransactionSimulation } from "./evm-client";
import type { ExecutionIntentInput, StoredExecutionIntent } from "./postgres";

const owner = "0x0000000000000000000000000000000000000003";
const sell = "0x0000000000000000000000000000000000000001";
const buy = "0x0000000000000000000000000000000000000002";
const target = "0x0000000000000000000000000000000000000004";
const auth = { id:"a1",owner,chainId:137,allowedTokens:[sell,buy],allowedTargets:[target],maximumSellAmount:"1000000",
 expiresAt:2_000_000_000_000,revokedAt:null,authorizedBy:"audited_smart_account" as const };

type TestDependencies = {
  quotes: Pick<ExecutionDependencies["quotes"], "getFirmQuote">;
  chain: Pick<ExecutionDependencies["chain"], "simulateExactSwap">;
  store: Pick<ExecutionDependencies["store"], "createOrGetIntent" | "recordBroadcast" | "recordSubmissionUnknown" | "recordSettlement">;
  loadRiskState: () => Promise<ExecutionRiskState>;
  submitAuthorized?: ExecutionDependencies["submitAuthorized"];
  now?: () => number;
};
function dependencies(overrides: Partial<TestDependencies> = {}): ExecutionDependencies {
  const quote = { provider:"0x" as const,chainId:137 as const,sellToken:sell as `0x${string}`,buyToken:buy as `0x${string}`,
    sellAmount:100n,buyAmount:200n,minBuyAmount:190n,taker:owner as `0x${string}`,allowanceTarget:null,
    transaction:{to:target as `0x${string}`,data:"0x12345678" as `0x${string}`,value:0n},liquiditySources:[],estimatedGas:100n,
    quoteTimestamp:1,priceImpactBps:10,slippageBps:50,rawFeeAmounts:[] };
  const base = {
    quotes:{getFirmQuote:vi.fn(async()=>quote)},
    chain:{simulateExactSwap:vi.fn(async()=>({chainId:137 as const,from:owner as `0x${string}`,to:target as `0x${string}`,data:"0x12345678" as `0x${string}`,value:0n,gasEstimate:100n}))},
    store:{createOrGetIntent:vi.fn(async(input) => ({record:{...input,id:input.id,status:"prepared" as const,txHash:null,nonce:null},created:true})),
      recordBroadcast:vi.fn(async()=>{}),recordSubmissionUnknown:vi.fn(async()=>{}),recordSettlement:vi.fn(async()=>{})},
    loadRiskState:vi.fn(async()=>({tradingEnabled:true,emergencyStop:false,maximumSlippageBps:50,allowedTokens:[sell,buy],allowedTargets:[target]})),
    now:()=>1_800_000_000_000,
  };
  return { ...base,...overrides } as unknown as ExecutionDependencies;
}
function request() { return {id:"tx1",idempotencyKey:"key1",owner,sellToken:sell,buyToken:buy,sellAmount:"100",slippageBps:50,authorization:auth}; }

describe("Polygon execution pipeline boundaries",()=>{
  it("quotes, reserves durable intent, then simulates exact transaction",async()=>{
    const d=dependencies();
    const p=new PolygonExecutionPipeline(d);
    const result=await p.prepare(request());
    expect(d.quotes.getFirmQuote).toHaveBeenCalledOnce();
    expect(d.store.createOrGetIntent).toHaveBeenCalledOnce();
    expect(d.chain.simulateExactSwap).toHaveBeenCalledOnce();
    expect(result.status).toBe("prepared");
  });
  it("does not proceed when emergency stop is active",async()=>{
    const d=dependencies({loadRiskState:vi.fn(async()=>({tradingEnabled:true,emergencyStop:true,maximumSlippageBps:50,allowedTokens:[sell,buy],allowedTargets:[target]}))});
    await expect(new PolygonExecutionPipeline(d).prepare(request())).rejects.toThrow(/paused/);
    expect(d.quotes.getFirmQuote).not.toHaveBeenCalled();
  });
  it("never creates an implicit backend signer",()=>{
    expect(assertLiveExecutionUnavailable).toThrow(/hard-disabled/);
  });
  it("rechecks stop immediately before submission",async()=>{
    const d=dependencies({loadRiskState:vi.fn()
      .mockResolvedValueOnce({tradingEnabled:true,emergencyStop:false,maximumSlippageBps:50,allowedTokens:[sell,buy],allowedTargets:[target]})
      .mockResolvedValueOnce({tradingEnabled:false,emergencyStop:true,maximumSlippageBps:50,allowedTokens:[sell,buy],allowedTargets:[target]})});
    const p=new PolygonExecutionPipeline(d);
    const prepared=await p.prepare(request());
    await expect(p.submitPrepared(prepared,request())).rejects.toThrow(/emergency stop/);
  });
});
