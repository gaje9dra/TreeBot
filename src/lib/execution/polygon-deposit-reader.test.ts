import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex } from "viem";
import { ViemPolygonDepositReader, ERC20_TRANSFER_TOPIC } from "./polygon-deposit-reader";

const abi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const token = "0x0000000000000000000000000000000000000020" as Address;
const sender = "0x0000000000000000000000000000000000000030" as Address;
const vault = "0x0000000000000000000000000000000000000010" as Address;

describe("ViemPolygonDepositReader", () => {
  it("scans only configured tokens and the configured vault recipient", async () => {
    const topics = encodeEventTopics({ abi, eventName: "Transfer", args: { from: sender, to: vault } });
    const client = {
      getChainId: vi.fn(async () => 137),
      getBlockNumber: vi.fn(async () => 200n),
      getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
        number: blockNumber, hash: (`0x${blockNumber.toString(16).padStart(64, "0")}`) as Hex,
        parentHash: (`0x${(blockNumber - 1n).toString(16).padStart(64, "0")}`) as Hex,
      })),
      getLogs: vi.fn(async () => [{
        address: token,
        topics: topics as [Hex, ...Hex[]],
        data: encodeAbiParameters([{ type: "uint256" }], [123n]),
        blockNumber: 100n, blockHash: (`0x${"1".repeat(64)}`) as Hex,
        transactionHash: (`0x${"2".repeat(64)}`) as Hex, logIndex: 7,
      }]),
      getTransactionReceipt: vi.fn(async () => ({})),
      getTransaction: vi.fn(async () => ({})),
    };
    const reader = new ViemPolygonDepositReader("https://polygon-rpc.example", client as never);
    const logs = await reader.getLogs({
      fromBlock: 100n, toBlock: 120n, address: [token], event: "Transfer", recipientTopics: [vault],
    });
    expect(client.getLogs).toHaveBeenCalledWith(expect.objectContaining({ address: [token], fromBlock: 100n, toBlock: 120n }));
    expect(logs).toEqual([expect.objectContaining({
      tokenAddress: token, senderAddress: sender, recipientAddress: vault, amount: 123n, logIndex: 7,
    })]);
    expect(ERC20_TRANSFER_TOPIC).toBe(topics[0]);
  });

  it("rejects insecure non-local RPC URLs", () => {
    expect(() => new ViemPolygonDepositReader("http://polygon.example")).toThrow(/HTTPS/);
  });

  it("rejects malformed block ranges", async () => {
    const client = { getLogs: vi.fn() };
    const reader = new ViemPolygonDepositReader("https://polygon-rpc.example", client as never);
    await expect(reader.getLogs({
      fromBlock: 50n, toBlock: 49n, address: [token], event: "Transfer", recipientTopics: [vault],
    })).rejects.toThrow(/range/);
  });
});
