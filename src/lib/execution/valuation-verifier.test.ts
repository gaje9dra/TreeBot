import { describe, expect, it } from "vitest";
import type { Address, Hash } from "viem";
import {
  isIssuedVerifiedAssetValuation,
  verifyChainlinkAssetValuation,
  type ValuationReader,
} from "./valuation-verifier";

const asset = "0x0000000000000000000000000000000000000001" as Address;
const quote = "0x0000000000000000000000000000000000000002" as Address;
const assetFeed = "0x0000000000000000000000000000000000000011" as Address;
const quoteFeed = "0x0000000000000000000000000000000000000012" as Address;
const blockHash = ("0x" + "a".repeat(64)) as Hash;
const now = BigInt(Math.floor(Date.now()/1000));
function reader(overrides:{chainId?:number;head?:bigint;hash?:Hash;assetUpdatedAt?:bigint;quoteUpdatedAt?:bigint;assetAnswer?:bigint;quoteAnswer?:bigint}={}):ValuationReader{
  const timestamp=now-60n;
  return {
    getChainId:async()=>overrides.chainId??137,
    getBlockNumber:async()=>overrides.head??1000n,
    getBlock:async({blockNumber})=>({number:blockNumber,hash:overrides.hash??blockHash,parentHash:blockHash,timestamp}),
    readFeedDecimals:async()=>8,
    readLatestRoundData:async({address})=>address.toLowerCase()===assetFeed.toLowerCase()
      ?{roundId:10n,answer:overrides.assetAnswer??200_000_000n,updatedAt:overrides.assetUpdatedAt??now-120n,answeredInRound:10n}
      :{roundId:20n,answer:overrides.quoteAnswer??100_000_000n,updatedAt:overrides.quoteUpdatedAt??now-120n,answeredInRound:20n},
  };
}
const request={
  accountId:"0x0000000000000000000000000000000000000003",
  assetAddress:asset,quoteAssetAddress:quote,assetFeedAddress:assetFeed,quoteFeedAddress:quoteFeed,
  tokenDecimals:6,quoteTokenDecimals:6,requiredConfirmations:64,maxStalenessSeconds:300,
};

describe("verifyChainlinkAssetValuation",()=>{
  it("derives a reduced exact quote-base-unit ratio from two finalized Chainlink rounds",async()=>{
    const proof=await verifyChainlinkAssetValuation(reader(),reader(),request);
    expect(isIssuedVerifiedAssetValuation(proof)).toBe(true);
    expect(proof).toMatchObject({
      chainId:137,accountId:request.accountId,priceNumerator:"2",priceDenominator:"1",
      tokenDecimals:6,valuationSource:"chainlink_polygon",requiredConfirmations:64,confirmations:64,
      assetAnswer:"200000000",quoteAnswer:"100000000",assetRoundId:"10",quoteRoundId:"20",
    });
  });

  it("rejects providers that disagree on the finalized block hash",async()=>{
    await expect(verifyChainlinkAssetValuation(reader(),reader({hash:("0x"+"b".repeat(64)) as Hash}),request)).rejects.toThrow(/disagree/);
  });

  it("rejects a stale oracle round",async()=>{
    await expect(verifyChainlinkAssetValuation(reader({assetUpdatedAt:now-1000n}),reader(),request)).rejects.toThrow(/stale/);
  });

  it("rejects non-positive oracle answers and wrong chains",async()=>{
    await expect(verifyChainlinkAssetValuation(reader({assetAnswer:0n}),reader(),request)).rejects.toThrow(/non-positive/);
    await expect(verifyChainlinkAssetValuation(reader({chainId:1}),reader(),request)).rejects.toThrow(/Polygon chain ID/);
  });

  it("rejects policies weaker than the 64-block finality minimum",async()=>{
    await expect(verifyChainlinkAssetValuation(reader(),reader(),{...request,requiredConfirmations:12})).rejects.toThrow(/policy is invalid/);
  });

  it("does not trust a caller-created valuation-shaped object",()=>{
    expect(isIssuedVerifiedAssetValuation({...request,chainId:137,priceNumerator:"2",priceDenominator:"1",valuationSource:"chainlink_polygon"})).toBe(false);
  });
});
