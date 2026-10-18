import { describe, expect, it, vi } from "vitest";
import { getAddress, isAddress, type Address } from "viem";
import { PolygonExecutionReadClient } from "../evm-client";
import { PolygonExecutionPipeline, type ExecutionDependencies } from "../pipeline";
import { assertLiveExecutionUnavailable } from "../authorization";

const rpcUrl = process.env.TREEBOT_INTEGRATION_RPC_URL;
const enabled = process.env.TREEBOT_RUN_CHAIN_INTEGRATION === "true" && Boolean(rpcUrl);
const describeChain = enabled ? describe : describe.skip;
const owner = (process.env.TREEBOT_TEST_WALLET_ADDRESS ?? "0x0000000000000000000000000000000000000003") as Address;
const sell = (process.env.TREEBOT_TEST_SELL_TOKEN ?? "0x0000000000000000000000000000000000000001") as Address;
const buy = (process.env.TREEBOT_TEST_BUY_TOKEN ?? "0x0000000000000000000000000000000000000002") as Address;
const target = (process.env.TREEBOT_TEST_TARGET ?? "0x0000000000000000000000000000000000000004") as Address;

function checkedAddress(value: string, label: string): Address {
  if (!isAddress(value, { strict: false })) throw new Error(`Invalid ${label} address configuration.`);
  return getAddress(value);
}
const checksummed = {
  owner: checkedAddress(owner, "TREEBOT_TEST_WALLET_ADDRESS"),
  sell: checkedAddress(sell, "TREEBOT_TEST_SELL_TOKEN"),
  buy: checkedAddress(buy, "TREEBOT_TEST_BUY_TOKEN"),
  target: checkedAddress(target, "TREEBOT_TEST_TARGET"),
};

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
      provider:"0x" as const, chainId:137 as const, sellToken:checksummed.sell, buyToken:checksummed.buy, sellAmount:10n, buyAmount:20n,
      minBuyAmount:19n,taker:checksummed.owner,allowanceTarget:null,transaction:{to:checksummed.target,data:"0x12345678" as `0x${string}`,value:0n},
      liquiditySources:[],estimatedGas:100n,quoteTimestamp:1,priceImpactBps:0,slippageBps:10,rawFeeAmounts:[],
    };
    const quoteClient = { getFirmQuote: vi.fn(async()=>q) };
    const chain = { simulateExactSwap: vi.fn(async()=>({chainId:137 as const,from:checksummed.owner,to:checksummed.target,data:q.transaction.data,value:0n,gasEstimate:100n})) };
    const store = {
      createOrGetIntent: vi.fn(async(input) => ({created:true,record:{...input,id:input.id,status:"prepared" as const,txHash:null,nonce:null}})),
      recordBroadcast: vi.fn(async()=>{}),recordSubmissionUnknown:vi.fn(async()=>{}),recordSettlement:vi.fn(async()=>{}),
    };
    const loadRiskState = vi.fn()
      .mockResolvedValueOnce({tradingEnabled:true,emergencyStop:false,maximumSlippageBps:10,allowedTokens:[checksummed.sell,checksummed.buy],allowedTargets:[checksummed.target]})
      .mockResolvedValueOnce({tradingEnabled:true,emergencyStop:false,maximumSlippageBps:10,allowedTokens:[sell,buy],allowedTargets:[target]})
      .mockResolvedValueOnce({tradingEnabled:false,emergencyStop:true,maximumSlippageBps:10,allowedTokens:[sell,buy],allowedTargets:[target]});
    const deps: ExecutionDependencies = {
      quotes:quoteClient as unknown as ExecutionDependencies["quotes"], chain:chain as unknown as ExecutionDependencies["chain"], store:store as unknown as ExecutionDependencies["store"], loadRiskState,
      submitAuthorized:vi.fn(async()=>({hash:("0x"+"1".repeat(64)) as `0x${string}`,nonce:1})),
      now:()=>1_800_000_000_000,
    };
    const api = new PolygonExecutionPipeline(deps);
    const request = {id:"integration-test",idempotencyKey:"integration-test-key",owner:checksummed.owner,sellToken:checksummed.sell,buyToken:checksummed.buy,sellAmount:"10",slippageBps:10,
      authorization:{id:"auth",owner:checksummed.owner,chainId:137,allowedTokens:[checksummed.sell,checksummed.buy],allowedTargets:[checksummed.target],maximumSellAmount:"10",
        expiresAt:2_000_000_000_000,revokedAt:null,authorizedBy:"audited_smart_account" as const}};
    const prepared = await api.prepare(request);
    const injectedBroadcaster = deps.submitAuthorized;
    await expect(api.submitPrepared(prepared,request)).rejects.toThrow(/paused|emergency stop|changed risk control/i);
    expect(injectedBroadcaster).not.toHaveBeenCalled();
  });
});
