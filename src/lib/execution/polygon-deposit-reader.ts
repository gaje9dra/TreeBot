import {
  createPublicClient,
  http,
  getAddress,
  isAddress,
  parseAbi,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";
import { polygon } from "viem/chains";
import type {
  DepositLogCandidate,
  DepositRangeReader,
  DepositScanBlock,
} from "./deposit-scanner";

const scanAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;

export class ViemPolygonDepositReader implements DepositRangeReader {
  readonly publicClient: PublicClient;

  constructor(rpcUrl: string, client?: PublicClient) {
    let url: URL;
    try { url = new URL(rpcUrl); } catch { throw new Error("POLYGON_RPC_URL must be a valid URL."); }
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new Error("POLYGON_RPC_URL must use HTTPS outside local development.");
    }
    this.publicClient = client ?? createPublicClient({ chain: polygon, transport: http(url.toString(), { timeout: 10_000, retryCount: 2, retryDelay: 500 }) }) as PublicClient;
  }

  async getChainId(): Promise<number> {
    return this.publicClient.getChainId();
  }

  async getBlockNumber(): Promise<bigint> {
    return this.publicClient.getBlockNumber();
  }

  async getBlock(args: { blockNumber: bigint }): Promise<DepositScanBlock> {
    const block = await this.publicClient.getBlock({ blockNumber: args.blockNumber });
    return { number: block.number, hash: block.hash as Hash, parentHash: block.parentHash };
  }

  async getLogs(args: {
    fromBlock: bigint;
    toBlock: bigint;
    address: readonly Address[];
    event: "Transfer";
    recipientTopics: readonly Hex[];
  }): Promise<readonly DepositLogCandidate[]> {
    if (args.fromBlock < 0n || args.toBlock < args.fromBlock) throw new Error("Invalid Polygon log range.");
    if (!args.address.length) throw new Error("At least one token contract is required.");
    const normalizedTokens = args.address.map((token) => {
      if (!isAddress(token)) throw new Error("Configured deposit token address is invalid.");
      return getAddress(token);
    });
    const normalizedRecipients = args.recipientTopics.map((recipient) => {
      if (!isAddress(recipient)) throw new Error("Configured vault address is invalid.");
      return getAddress(recipient);
    });
    const logs = await this.publicClient.getLogs({
      address: normalizedTokens,
      event: scanAbi[0],
      args: { to: normalizedRecipients[0] as Address },
      fromBlock: args.fromBlock,
      toBlock: args.toBlock,
    });
    const out: DepositLogCandidate[] = [];
    for (const log of logs) {
      if (!log.transactionHash || log.blockNumber === null || !log.blockHash || log.logIndex === null) continue;
      if (!log.topics[0] || log.topics[0].toLowerCase() !== transferTopic.toLowerCase()) continue;
      if (!log.topics[1] || !log.topics[2]) continue;
      const sender = (`0x${log.topics[1].slice(-40)}`) as Address;
      const recipient = (`0x${log.topics[2].slice(-40)}`) as Address;
      if (!isAddress(sender) || !isAddress(recipient) || !log.data || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) continue;
      out.push({
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        logIndex: log.logIndex,
        tokenAddress: getAddress(log.address),
        senderAddress: getAddress(sender),
        recipientAddress: getAddress(recipient),
        amount: BigInt(log.data),
      });
    }
    return out;
  }

  async getTransactionReceipt(args: { hash: Hash }) {
    const r = await this.publicClient.getTransactionReceipt(args);
    return {
      transactionHash: r.transactionHash,
      status: r.status === "success" ? "success" as const : "reverted" as const,
      blockNumber: r.blockNumber,
      blockHash: r.blockHash,
      logs: r.logs.map((log) => ({ address: getAddress(log.address), data: log.data, topics: log.topics, logIndex: log.logIndex })),
    };
  }

  async getTransaction(args: { hash: Hash }) {
    const tx = await this.publicClient.getTransaction(args);
    return { hash: tx.hash, from: getAddress(tx.from), to: tx.to ? getAddress(tx.to) : null, input: tx.input };
  }
}

export { transferTopic as ERC20_TRANSFER_TOPIC };
