import {
  createPublicClient,http,isAddress,getAddress,parseAbi,decodeEventLog,
  type Address,type Hash,type Hex,type PublicClient,
} from "viem";
import { polygon } from "viem/chains";
import type { ValidatedSwapQuote } from "./zero-ex";

export const ERC20_ABI=parseAbi([
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender,uint256 value) returns (bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
export interface TransactionSimulation{chainId:137;from:Address;to:Address;data:Hex;value:bigint;gasEstimate:bigint;}
export interface ReceiptSettlement{hash:Hash;status:"confirmed"|"reverted";blockNumber:bigint;gasUsed:bigint;effectiveGasPrice:bigint;gasCostWei:bigint;}
export class ChainValidationError extends Error{constructor(message:string){super(message);this.name="ChainValidationError";}}
/** Read/simulation-only client; deliberately contains no signer or generic broadcast method. */
export class PolygonExecutionReadClient{
  readonly publicClient:PublicClient;
  constructor(rpcUrl:string,client?:PublicClient){
    let u:URL;try{u=new URL(rpcUrl);}catch{throw new Error("POLYGON_RPC_URL must be a valid URL.");}
    if(u.protocol!=="https:"&&u.hostname!=="localhost"&&u.hostname!=="127.0.0.1")throw new Error("POLYGON_RPC_URL must use HTTPS outside local development.");
    this.publicClient=client??createPublicClient({chain:polygon,transport:http(u.toString(),{timeout:10_000})}) as PublicClient;
  }
  async assertPolygon(){const id=await this.publicClient.getChainId();if(id!==137)throw new ChainValidationError(`Expected Polygon chain ID 137, received ${id}.`);}
  async simulateExactSwap(quote:ValidatedSwapQuote,from:string):Promise<TransactionSimulation>{
    await this.assertPolygon();if(!isAddress(from))throw new ChainValidationError("Invalid sender address.");
    const sender=getAddress(from);if(quote.chainId!==137||quote.taker!==sender)throw new ChainValidationError("Quote chain/taker does not match execution wallet.");
    const {to,data,value}=quote.transaction;await this.publicClient.call({account:sender,to,data,value});
    const gasEstimate=await this.publicClient.estimateGas({account:sender,to,data,value});
    return {chainId:137,from:sender,to,data,value,gasEstimate};
  }
  async erc20Allowance(token:string,owner:string,spender:string):Promise<bigint>{
    await this.assertPolygon();if(![token,owner,spender].every(isAddress))throw new ChainValidationError("Invalid ERC-20 allowance address.");
    return this.publicClient.readContract({address:getAddress(token),abi:ERC20_ABI,functionName:"allowance",args:[getAddress(owner),getAddress(spender)]});
  }
  async getErc20Balance(token:string,owner:string):Promise<bigint>{
    await this.assertPolygon();if(![token,owner].every(isAddress))throw new ChainValidationError("Invalid ERC-20 balance address.");
    return this.publicClient.readContract({address:getAddress(token),abi:ERC20_ABI,functionName:"balanceOf",args:[getAddress(owner)]});
  }
  async waitForSettlement(hash:Hash,confirmations=3,timeout=120_000):Promise<ReceiptSettlement>{
    await this.assertPolygon();if(!Number.isInteger(confirmations)||confirmations<1||confirmations>256)throw new Error("Confirmation count must be 1 to 256.");
    const r=await this.publicClient.waitForTransactionReceipt({hash,confirmations,timeout,pollingInterval:2_000,retryCount:0}),p=r.effectiveGasPrice;
    return {hash:r.transactionHash,status:r.status==="success"?"confirmed":"reverted",blockNumber:r.blockNumber,gasUsed:r.gasUsed,effectiveGasPrice:p,gasCostWei:r.gasUsed*p};
  }
  async reconcileHash(hash:Hash):Promise<{found:false}|{found:true;settlement:ReceiptSettlement}>{
    await this.assertPolygon();try{const r=await this.publicClient.getTransactionReceipt({hash}),p=r.effectiveGasPrice;
      return {found:true,settlement:{hash:r.transactionHash,status:r.status==="success"?"confirmed":"reverted",blockNumber:r.blockNumber,gasUsed:r.gasUsed,effectiveGasPrice:p,gasCostWei:r.gasUsed*p}};
    }catch{return {found:false};}
  }
  async tokenTransferEvents(hash:Hash,from?:string,to?:string):Promise<Array<{from:Address;to:Address;value:bigint;logIndex:number}>>{
    await this.assertPolygon();const r=await this.publicClient.getTransactionReceipt({hash}),out:Array<{from:Address;to:Address;value:bigint;logIndex:number}>=[];
    for(const log of r.logs){try{const d=decodeEventLog({abi:ERC20_ABI,eventName:"Transfer",data:log.data,topics:log.topics}),a=d.args as {from:Address;to:Address;value:bigint};
      if((!from||a.from.toLowerCase()===from.toLowerCase())&&(!to||a.to.toLowerCase()===to.toLowerCase()))out.push({...a,logIndex:log.logIndex??0});
    }catch{/* Other event signatures are ignored. */}}
    return out;
  }
}
