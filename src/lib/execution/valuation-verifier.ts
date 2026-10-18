import { getAddress, isAddress, type Address, type Hash } from "viem";

const MIN_VALUATION_CONFIRMATIONS = 64;
const SOURCE = "chainlink_polygon" as const;
const issuedValuations = new WeakSet<object>();

export interface ChainlinkRound {
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint;
  answeredInRound: bigint;
}
export interface ValuationReader {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBlock(args:{blockNumber:bigint}):Promise<{number:bigint;hash:Hash;parentHash:Hash;timestamp:bigint}>;
  readFeedDecimals(args:{address:Address;blockNumber:bigint}):Promise<number>;
  readLatestRoundData(args:{address:Address;blockNumber:bigint}):Promise<ChainlinkRound>;
}
export interface AssetValuationRequest {
  accountId:string;
  assetAddress:Address;
  quoteAssetAddress:Address;
  assetFeedAddress:Address;
  quoteFeedAddress:Address;
  tokenDecimals:number;
  quoteTokenDecimals:number;
  requiredConfirmations:number;
  maxStalenessSeconds:number;
}
export interface VerifiedAssetValuation {
  readonly chainId:137;
  readonly accountId:string;
  readonly assetAddress:Address;
  readonly quoteAssetAddress:Address;
  readonly priceNumerator:string;
  readonly priceDenominator:string;
  readonly tokenDecimals:number;
  readonly valuationSource:typeof SOURCE;
  readonly observedAt:string;
  readonly freshnessDeadline:string;
  readonly blockNumber:string;
  readonly blockHash:Hash;
  readonly requiredConfirmations:number;
  readonly confirmations:number;
  readonly assetFeedAddress:Address;
  readonly quoteFeedAddress:Address;
  readonly assetRoundId:string;
  readonly quoteRoundId:string;
  readonly assetAnswer:string;
  readonly quoteAnswer:string;
  readonly assetFeedDecimals:number;
  readonly quoteFeedDecimals:number;
}

export function isIssuedVerifiedAssetValuation(value:unknown):value is VerifiedAssetValuation{
  if(typeof value!=="object"||value===null||!issuedValuations.has(value))return false;
  const proof=value as Partial<VerifiedAssetValuation>;
  return proof.chainId===137&&typeof proof.accountId==="string"&&proof.accountId.trim().length>0&&
    proof.valuationSource===SOURCE&&typeof proof.priceNumerator==="string"&&/^[1-9][0-9]*$/.test(proof.priceNumerator)&&
    typeof proof.priceDenominator==="string"&&/^[1-9][0-9]*$/.test(proof.priceDenominator)&&
    Number.isInteger(proof.confirmations)&&Number(proof.confirmations)>=MIN_VALUATION_CONFIRMATIONS&&
    Number.isInteger(proof.requiredConfirmations)&&Number(proof.requiredConfirmations)>=MIN_VALUATION_CONFIRMATIONS&&
    typeof proof.blockHash==="string"&&/^0x[0-9a-fA-F]{64}$/.test(proof.blockHash);
}

function gcd(a:bigint,b:bigint):bigint{
  let left=a<0n?-a:a,right=b<0n?-b:b;
  while(right!==0n){const next=left%right;left=right;right=next;}
  return left;
}
function pow10(decimals:number):bigint{return 10n**BigInt(decimals);}
function validateRound(round:ChainlinkRound,feedDecimals:number,blockTimestamp:bigint,maxStalenessSeconds:number,label:string):void{
  if(!Number.isInteger(feedDecimals)||feedDecimals<0||feedDecimals>36)throw new Error(`${label} feed decimals are invalid.`);
  if(round.roundId<=0n||round.answer<=0n||round.answeredInRound<round.roundId||round.updatedAt<=0n)throw new Error(`${label} Chainlink round is incomplete or non-positive.`);
  if(round.updatedAt>blockTimestamp||blockTimestamp-round.updatedAt>BigInt(maxStalenessSeconds))throw new Error(`${label} Chainlink round is stale or from the future.`);
}

/** Requires two independent Polygon RPC providers to agree on the same finalized block and verifies both Chainlink rounds at that block. */
export async function verifyChainlinkAssetValuation(
  primary:ValuationReader,
  fallback:ValuationReader,
  request:AssetValuationRequest,
):Promise<VerifiedAssetValuation>{
  if(!request.accountId.trim()||![request.assetAddress,request.quoteAssetAddress,request.assetFeedAddress,request.quoteFeedAddress].every(isAddress))
    throw new Error("Asset valuation identity or feed addresses are invalid.");
  if(getAddress(request.assetAddress)===getAddress(request.quoteAssetAddress))throw new Error("Quote-token self-valuations are exact and do not require an oracle.");
  if(!Number.isInteger(request.tokenDecimals)||request.tokenDecimals<0||request.tokenDecimals>36||
     !Number.isInteger(request.quoteTokenDecimals)||request.quoteTokenDecimals<0||request.quoteTokenDecimals>36||
     !Number.isInteger(request.requiredConfirmations)||request.requiredConfirmations<MIN_VALUATION_CONFIRMATIONS||request.requiredConfirmations>10_000||
     !Number.isInteger(request.maxStalenessSeconds)||request.maxStalenessSeconds<30||request.maxStalenessSeconds>86_400)
    throw new Error("Asset valuation decimals, finality, or staleness policy is invalid.");
  const [primaryChain,fallbackChain,primaryHead,fallbackHead]=await Promise.all([
    primary.getChainId(),fallback.getChainId(),primary.getBlockNumber(),fallback.getBlockNumber(),
  ]);
  if(primaryChain!==137||fallbackChain!==137)throw new Error("Both valuation RPC providers must report Polygon chain ID 137.");
  const head=primaryHead<fallbackHead?primaryHead:fallbackHead;
  const confirmations=Number(request.requiredConfirmations);
  const finalBlock=head-BigInt(confirmations)+1n;
  if(finalBlock<0n)throw new Error("Polygon does not yet have enough blocks for the valuation finality policy.");
  const [primaryBlock,fallbackBlock]=await Promise.all([
    primary.getBlock({blockNumber:finalBlock}),fallback.getBlock({blockNumber:finalBlock}),
  ]);
  if(primaryBlock.number!==finalBlock||fallbackBlock.number!==finalBlock||primaryBlock.hash.toLowerCase()!==fallbackBlock.hash.toLowerCase())
    throw new Error("Valuation RPC providers disagree on the finalized Polygon block hash.");
  const nowSeconds=BigInt(Math.floor(Date.now()/1000));
  if(primaryBlock.timestamp>nowSeconds+60n)throw new Error("Finalized Polygon block timestamp is unexpectedly in the future.");
  const [assetFeedDecimals,quoteFeedDecimals,assetRound,quoteRound]=await Promise.all([
    primary.readFeedDecimals({address:getAddress(request.assetFeedAddress),blockNumber:finalBlock}),
    primary.readFeedDecimals({address:getAddress(request.quoteFeedAddress),blockNumber:finalBlock}),
    primary.readLatestRoundData({address:getAddress(request.assetFeedAddress),blockNumber:finalBlock}),
    primary.readLatestRoundData({address:getAddress(request.quoteFeedAddress),blockNumber:finalBlock}),
  ]);
  validateRound(assetRound,assetFeedDecimals,primaryBlock.timestamp,request.maxStalenessSeconds,"Asset");
  validateRound(quoteRound,quoteFeedDecimals,primaryBlock.timestamp,request.maxStalenessSeconds,"Quote");
  const [primaryAfter,fallbackAfter]=await Promise.all([
    primary.getBlock({blockNumber:finalBlock}),fallback.getBlock({blockNumber:finalBlock}),
  ]);
  if(primaryAfter.hash.toLowerCase()!==primaryBlock.hash.toLowerCase()||fallbackAfter.hash.toLowerCase()!==primaryBlock.hash.toLowerCase())
    throw new Error("Valuation block changed during oracle reads.");
  const rawNumerator=assetRound.answer*pow10(quoteFeedDecimals)*pow10(request.quoteTokenDecimals);
  const rawDenominator=quoteRound.answer*pow10(assetFeedDecimals)*pow10(request.tokenDecimals);
  const divisor=gcd(rawNumerator,rawDenominator);
  const numerator=rawNumerator/divisor,denominator=rawDenominator/divisor;
  if(numerator<=0n||denominator<=0n||numerator.toString().length>78||denominator.toString().length>78)
    throw new Error("Exact valuation ratio exceeds the supported PostgreSQL numeric range.");
  const observedAtMs=Number(primaryBlock.timestamp)*1000;
  if(!Number.isSafeInteger(observedAtMs))throw new Error("Finalized block timestamp is outside the supported date range.");
  const observedAt=new Date(observedAtMs);
  const freshnessDeadlineMs=(primaryBlock.timestamp+BigInt(request.maxStalenessSeconds))*1000n;
  if(freshnessDeadlineMs<=BigInt(Date.now()))throw new Error("Valuation is already stale at verification time.");
  const freshnessDeadline=new Date(freshnessDeadlineMs>BigInt(Number.MAX_SAFE_INTEGER)?Number.MAX_SAFE_INTEGER:Number(freshnessDeadlineMs));
  const proof:VerifiedAssetValuation=Object.freeze({
    chainId:137,accountId:request.accountId,assetAddress:getAddress(request.assetAddress),quoteAssetAddress:getAddress(request.quoteAssetAddress),
    priceNumerator:numerator.toString(),priceDenominator:denominator.toString(),tokenDecimals:request.tokenDecimals,valuationSource:SOURCE,
    observedAt:observedAt.toISOString(),freshnessDeadline:freshnessDeadline.toISOString(),blockNumber:finalBlock.toString(),
    blockHash:primaryBlock.hash.toLowerCase() as Hash,requiredConfirmations:request.requiredConfirmations,confirmations:Number(primaryHead-finalBlock+1n),
    assetFeedAddress:getAddress(request.assetFeedAddress),quoteFeedAddress:getAddress(request.quoteFeedAddress),
    assetRoundId:assetRound.roundId.toString(),quoteRoundId:quoteRound.roundId.toString(),assetAnswer:assetRound.answer.toString(),
    quoteAnswer:quoteRound.answer.toString(),assetFeedDecimals,quoteFeedDecimals,
  });
  issuedValuations.add(proof);
  return proof;
}
