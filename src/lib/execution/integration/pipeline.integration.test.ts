import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { PolygonExecutionReadClient } from "../evm-client";
import { PolygonExecutionPipeline } from "../pipeline";
import { assertLiveExecutionUnavailable } from "../authorization";

const rpcUrl = process.env.TREEBOT_INTEGRATION_RPC_URL;
const enabled = process.env.TREEBOT_RUN_CHAIN_INTEGRATION === "true" && Boolean(rpcUrl);
const describeChain = enabled ? describe : describe.skip;
const owner = (process.env.TREEBOT_TEST_WALLET_ADDRESS ?? "0x0000000000000000000000000000000000000003") as Address;
const sell = (process.env.TREEBOT_TEST_SELL_TOKEN ?? "0x0000000000000000000000000000000000000001") as Address;
const buy = (process.env.TREEBOT_TEST_BUY_TOKEN ?? "0x0000000000000000000000000000000000000002") as Address;
const target = (process.env.TREEBOT_TEST_TARGET ?? "0x0000000000000000000000000000000000000004") as Address;

describeChain("Polygon execution chain integration", () => {
  it("verifies the configured RPC is Polygon chain 137", async () => {
    const client = new PolygonExecutionReadClient(rpcUrl!);
    await expect(client.assertPolygon()).resolves.toBeUndefined();
  });

  it("reads live ERC-20 balance and allowance on the configured chain", async () => {
    const client = new PolygonExecutionReadClient(rpcUrl!);
    await client.assertPolygon();
    const balance = await client.getErc20Balance(sell, owner);
    const allowance = await client.erc20Allowance(sell, owner, target);
    expect(balance).toBeGreaterThanOrEqual(0n);
    expect(allowance).toBeGreaterThanOrEqual(0n);
  });
});

describe("execution safety integration boundaries", () => {
  it("refuses live submission when no separately audited smart-account adapter is installed", () => {
    expect(assertLiveExecutionUnavailable).toThrow(/hard-disabled/);
  });

  it("does not call an injected broadcaster when the emergency stop changes", async () => {
    const q = {
      provider:"0x" as const, chainId:137 as const, sellToken:sell, buyToken:buy, sellAmount:10n, buyAmount:20n,
      minBuyAmount:19n,taker:owner,allowanceTarget:null,transaction:{to:target,data:"0x12345678" as `0x${string}`,value:0n},
      liquiditySources:[],estimatedGas:100n,quoteTimestamp:1,priceImpactBps:0,slippageBps:10,rawFeeAmounts:[],
    };
    const quoteClient = { getFirmQuote: vi.fn(async()=>q) };
    const chain = { simulateExactSwap: vi.fn(async()=>({chainId:137 as const,from:owner,to:target,data:q.transaction.data,value:0n,gasEstimate:100n})) };
    const store = {
      createOrGetIntent: vi.fn(async(input:any)=>({created:true,record:{...input,id:input.id,status:"prepared",txHash:null,nonce:null}})),
      recordBroadcast: vi.fn(async()=>{}),recordSubmissionUnknown:vi.fn(async()=>{}),recordSettlement:vi.fn(async()=>{}),
    };
    const loadRiskState = vi.fn()
      .mockResolvedValueOnce({tradingEnabled:true,emergencyStop:false,maximumSlippageBps:10,allowedTokens:[sell,buy],allowedTargets:[target]})
      .mockResolvedValueOnce({tradingEnabled:true,emergencyStop:false,maximumSlippageBps:10,allowedTokens:[sell,buy],allowedTargets:[target]})
      .mockResolvedValueOnce({tradingEnabled:false,emergencyStop:true,maximumSlippageBps:10,allowedTokens:[sell,buy],allowedTargets:[target]});
    const api = new PolygonExecutionPipeline({
      quotes:quoteClient as any, chain:chain as any, store:store as any, loadRiskState,
      submitAuthorized:vi.fn(async()=>({hash:("0x"+"1".repeat(64)) as `0x${string}`,nonce:1})),
      now:()=>1_800_000_000_000,
    });
    const request = {id:"integration-test",idempotencyKey:"integration-test-key",owner,sellToken:sell,buyToken:buy,sellAmount:"10",slippageBps:10,
      authorization:{id:"auth",owner,chainId:137,allowedTokens:[sell,buy],allowedTargets:[target],maximumSellAmount:"10",
        expiresAt:2_000_000_000_000,revokedAt:null,authorizedBy:"audited_smart_account" as const}};
    const prepared = await api.prepare(request);
    const injectedBroadcaster = (api as any).d.submitAuthorized;
    await expect(api.submitPrepared(prepared,request)).rejects.toThrow(/paused|emergency stop/i);
    expect(injectedBroadcaster).not.toHaveBeenCalled();
  });
});
