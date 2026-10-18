import { describe, expect, it, vi } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import {
  DepositVerificationError,
  TrustedDepositWatcher,
  type DepositChainReader,
  type DepositReceipt,
} from "./deposit-watcher";

const account = "0x0000000000000000000000000000000000000003" as Address;
const token = "0x0000000000000000000000000000000000000001" as Address;
const vault = "0x0000000000000000000000000000000000000004" as Address;
const hash = `0x${"1".repeat(64)}` as Hash;
const abi = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

function fixture() {
  const amount = 2500000n;
  const topics = encodeEventTopics({ abi, eventName: "Transfer", args: { from: account, to: vault } });
  const receipt: DepositReceipt = {
    transactionHash: hash,
    status: "success",
    blockNumber: 100n,
    logs: [{
      address: token,
      topics: topics as readonly Hex[],
      data: encodeAbiParameters([{ type: "uint256" }], [amount]),
      logIndex: 2,
    }],
  };
  const chain: DepositChainReader = {
    getChainId: vi.fn(async () => 137),
    getTransactionReceipt: vi.fn(async () => receipt),
    getTransaction: vi.fn(async () => ({
      hash,
      from: account,
      to: token,
      input: encodeFunctionData({ abi, functionName: "transfer", args: [vault, amount] }),
    })),
    getBlockNumber: vi.fn(async () => 163n),
  };
  const store = { recordDepositEvent: vi.fn(async () => ({ credited: true })) };
  return { chain, store, receipt };
}

const request = {
  transactionHash: hash,
  accountAddress: account,
  tokenAddress: token,
  vaultAddress: vault,
  minimumAmount: "2000000",
};

describe("TrustedDepositWatcher", () => {
  it("credits a successful direct ERC-20 transfer only after configured finality", async () => {
    const { chain, store } = fixture();
    await expect(new TrustedDepositWatcher(chain, store, 64).verifyAndCredit(request))
      .resolves.toEqual({ credited: true, amount: "2500000", confirmations: 64 });
    expect(store.recordDepositEvent).toHaveBeenCalledWith(expect.objectContaining({
      accountId: account,
      token,
      amount: "2500000",
      txHash: hash,
      logIndex: 2,
      blockNumber: "100",
      confirmed: true,
      requiredConfirmations: 64,
    }));
  });

  it("does not credit before the confirmation threshold", async () => {
    const { chain, store } = fixture();
    (chain.getBlockNumber as ReturnType<typeof vi.fn>).mockResolvedValue(162n);
    await expect(new TrustedDepositWatcher(chain, store, 64).verifyAndCredit(request))
      .rejects.toThrow(/confirmations/);
    expect(store.recordDepositEvent).not.toHaveBeenCalled();
  });

  it("does not credit a failed receipt", async () => {
    const { chain, store, receipt } = fixture();
    (chain.getTransactionReceipt as ReturnType<typeof vi.fn>).mockResolvedValue({ ...receipt, status: "reverted" });
    await expect(new TrustedDepositWatcher(chain, store, 1).verifyAndCredit(request))
      .rejects.toThrow(/pending, failed/);
    expect(store.recordDepositEvent).not.toHaveBeenCalled();
  });

  it("rejects transfer logs emitted by a different token contract", async () => {
    const { chain, store, receipt } = fixture();
    (chain.getTransactionReceipt as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...receipt,
      logs: receipt.logs.map((log) => ({ ...log, address: vault })),
    });
    await expect(new TrustedDepositWatcher(chain, store, 1).verifyAndCredit(request))
      .rejects.toThrow(/exactly one matching/);
    expect(store.recordDepositEvent).not.toHaveBeenCalled();
  });

  it("rejects unknown calldata instead of guessing the deposit method", async () => {
    const { chain, store } = fixture();
    (chain.getTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({
      hash,
      from: account,
      to: token,
      input: "0x12345678" as Hex,
    });
    await expect(new TrustedDepositWatcher(chain, store, 1).verifyAndCredit(request))
      .rejects.toThrow(/Unsupported deposit calldata/);
    expect(store.recordDepositEvent).not.toHaveBeenCalled();
  });

  it("rejects a calldata recipient different from the configured vault", async () => {
    const { chain, store } = fixture();
    (chain.getTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({
      hash,
      from: account,
      to: token,
      input: encodeFunctionData({ abi, functionName: "transfer", args: [account, 2500000n] }),
    });
    await expect(new TrustedDepositWatcher(chain, store, 1).verifyAndCredit(request))
      .rejects.toThrow(/recipient or amount/);
    expect(store.recordDepositEvent).not.toHaveBeenCalled();
  });

  it("rejects non-Polygon RPC state", async () => {
    const { chain, store } = fixture();
    (chain.getChainId as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    await expect(new TrustedDepositWatcher(chain, store, 1).verifyAndCredit(request))
      .rejects.toThrow(/chain ID 137/);
    expect(store.recordDepositEvent).not.toHaveBeenCalled();
  });

  it("passes duplicate notifications to the idempotent ledger and reports no second credit", async () => {
    const { chain, store } = fixture();
    store.recordDepositEvent.mockResolvedValue({ credited: false });
    await expect(new TrustedDepositWatcher(chain, store, 1).verifyAndCredit(request))
      .resolves.toEqual({ credited: false, amount: "2500000", confirmations: 64 });
    expect(store.recordDepositEvent).toHaveBeenCalledOnce();
  });
});
