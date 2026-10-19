import {
  decodeEventLog,
  getAddress,
  isAddress,
  parseAbi,
  type Address,
  type Hash,
  type Hex,
} from "viem";

const transferAbi = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const MIN_TRADE_CONFIRMATIONS = 64;
const issuedProofs = new WeakSet<object>();

export interface TradeReceiptLog {
  address: Address;
  data: Hex;
  topics: readonly Hex[];
  logIndex: number | null;
}
export interface TradeReceipt {
  transactionHash: Hash;
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: Hash;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  logs: readonly TradeReceiptLog[];
}
export interface TradeSettlementReader {
  getChainId(): Promise<number>;
  getTransactionReceipt(args: { hash: Hash }): Promise<TradeReceipt>;
  getTransaction(args: { hash: Hash }): Promise<{
    hash: Hash;
    from: Address;
    to: Address | null;
    input: Hex;
    value: bigint;
    nonce: number;
  }>;
  getBlockNumber(): Promise<bigint>;
  getBlock(args: { blockNumber: bigint }): Promise<{
    number: bigint;
    hash: Hash;
    parentHash: Hash;
  }>;
}
export interface TradeSettlementRequest {
  executionId: string;
  transactionHash: Hash;
  nonce: number;
  walletAddress: Address;
  sellToken: Address;
  buyToken: Address;
  reservedSellAmountBaseUnits: string;
  transactionTarget: Address;
  transactionData: Hex;
  transactionValueWei: string;
  requiredConfirmations: number;
}
export interface VerifiedTradeSettlement {
  readonly executionId: string;
  readonly chainId: 137;
  readonly transactionHash: Hash;
  readonly nonce: number;
  readonly status: "confirmed" | "reverted";
  readonly walletAddress: Address;
  readonly sellToken: Address;
  readonly buyToken: Address;
  readonly transactionTarget: Address;
  readonly transactionData: Hex;
  readonly transactionValueWei: string;
  readonly reservedSellAmountBaseUnits: string;
  readonly actualSellAmountBaseUnits: string;
  readonly actualBuyAmountBaseUnits: string;
  readonly gasWei: string;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly confirmations: number;
  readonly requiredConfirmations: number;
  readonly sellTransferLogIndexes: readonly number[];
  readonly buyTransferLogIndexes: readonly number[];
  readonly gasUsed: string;
  readonly effectiveGasPriceWei: string;
}

export function isIssuedVerifiedTradeSettlement(value: unknown): value is VerifiedTradeSettlement {
  if (typeof value !== "object" || value === null || !issuedProofs.has(value)) return false;
  const proof = value as Partial<VerifiedTradeSettlement>;
  return (
    proof.chainId === 137 &&
    typeof proof.executionId === "string" &&
    proof.executionId.length > 0 &&
    Number.isInteger(proof.requiredConfirmations) &&
    Number(proof.requiredConfirmations) >= MIN_TRADE_CONFIRMATIONS &&
    Number.isInteger(proof.confirmations) &&
    Number(proof.confirmations) >= Number(proof.requiredConfirmations) &&
    typeof proof.transactionHash === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(proof.transactionHash) &&
    Number.isSafeInteger(proof.nonce) &&
    Number(proof.nonce) >= 0 &&
    (proof.status === "confirmed" || proof.status === "reverted") &&
    typeof proof.reservedSellAmountBaseUnits === "string" &&
    /^[1-9][0-9]*$/.test(proof.reservedSellAmountBaseUnits) &&
    typeof proof.actualSellAmountBaseUnits === "string" &&
    /^(0|[1-9][0-9]*)$/.test(proof.actualSellAmountBaseUnits) &&
    typeof proof.actualBuyAmountBaseUnits === "string" &&
    /^(0|[1-9][0-9]*)$/.test(proof.actualBuyAmountBaseUnits) &&
    typeof proof.gasWei === "string" &&
    /^(0|[1-9][0-9]*)$/.test(proof.gasWei) &&
    typeof proof.blockNumber === "string" &&
    /^(0|[1-9][0-9]*)$/.test(proof.blockNumber) &&
    typeof proof.blockHash === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(proof.blockHash)
  );
}

/** Creates an unforgeable in-process proof only after exact transaction, receipt, log, and finality checks. */
export async function verifyTradeSettlement(
  reader: TradeSettlementReader,
  request: TradeSettlementRequest,
): Promise<VerifiedTradeSettlement> {
  if (
    !request.executionId.trim() ||
    !/^0x[0-9a-fA-F]{64}$/.test(request.transactionHash)
  ) {
    throw new Error("Trade settlement identity is invalid.");
  }
  if (
    ![
      request.walletAddress,
      request.sellToken,
      request.buyToken,
      request.transactionTarget,
    ].every(isAddress)
  ) {
    throw new Error("Trade settlement addresses are invalid.");
  }
  if (getAddress(request.sellToken) === getAddress(request.buyToken)) {
    throw new Error("Trade settlement sell and buy tokens must differ.");
  }
  if (
    getAddress(request.sellToken) === "0x0000000000000000000000000000000000000000" ||
    getAddress(request.buyToken) === "0x0000000000000000000000000000000000000000"
  ) {
    throw new Error("Trade settlement requires ERC-20 token addresses.");
  }
  if (
    !/^[1-9][0-9]*$/.test(request.reservedSellAmountBaseUnits) ||
    !/^(0|[1-9][0-9]*)$/.test(request.transactionValueWei) ||
    !Number.isSafeInteger(request.nonce) ||
    request.nonce < 0 ||
    !Number.isInteger(request.requiredConfirmations) ||
    request.requiredConfirmations < MIN_TRADE_CONFIRMATIONS ||
    request.requiredConfirmations > 10_000
  ) {
    throw new Error("Trade settlement amount, nonce, value, or confirmation policy is invalid.");
  }
  const txHash = request.transactionHash.toLowerCase() as Hash;
  const wallet = getAddress(request.walletAddress);
  const sellToken = getAddress(request.sellToken);
  const buyToken = getAddress(request.buyToken);
  const target = getAddress(request.transactionTarget);
  if ((await reader.getChainId()) !== 137) {
    throw new Error("Trade settlement RPC is not Polygon chain ID 137.");
  }
  const [receipt, transaction, head] = await Promise.all([
    reader.getTransactionReceipt({ hash: txHash }),
    reader.getTransaction({ hash: txHash }),
    reader.getBlockNumber(),
  ]);
  if (
    receipt.transactionHash.toLowerCase() !== txHash ||
    transaction.hash.toLowerCase() !== txHash
  ) {
    throw new Error("Trade receipt and transaction hashes disagree.");
  }
  if (
    getAddress(transaction.from) !== wallet ||
    transaction.to === null ||
    getAddress(transaction.to) !== target ||
    transaction.input.toLowerCase() !== request.transactionData.toLowerCase() ||
    transaction.value !== BigInt(request.transactionValueWei) ||
    transaction.nonce !== request.nonce
  ) {
    throw new Error(
      "Mined transaction does not match the exact reserved wallet, target, calldata, value, and nonce.",
    );
  }
  if (receipt.blockNumber < 0n || receipt.gasUsed < 0n || receipt.effectiveGasPrice < 0n) {
    throw new Error("Trade receipt contains invalid block or gas accounting.");
  }
  const canonical = await reader.getBlock({ blockNumber: receipt.blockNumber });
  if (
    canonical.number !== receipt.blockNumber ||
    canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase()
  ) {
    throw new Error("Trade receipt block is not canonical.");
  }
  const confirmationsBig = head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n;
  const confirmations = Number(
    confirmationsBig > BigInt(Number.MAX_SAFE_INTEGER)
      ? BigInt(Number.MAX_SAFE_INTEGER)
      : confirmationsBig,
  );
  if (confirmations < request.requiredConfirmations) {
    throw new Error("Trade receipt has insufficient confirmations.");
  }
  const reservedSell = BigInt(request.reservedSellAmountBaseUnits);
  let sellOut = 0n, sellIn = 0n, buyIn = 0n, buyOut = 0n;
  const sellIndexes: number[] = [], buyIndexes: number[] = [];
  for (const log of receipt.logs) {
    const address = getAddress(log.address);
    if (address !== sellToken && address !== buyToken) continue;
    let decoded: { args: { from: Address; to: Address; value: bigint } };
    try {
      const result = decodeEventLog({
        abi: transferAbi,
        eventName: "Transfer",
        data: log.data,
        topics: log.topics,
      });
      decoded = { args: result.args as { from: Address; to: Address; value: bigint } };
    } catch {
      continue;
    }
    const from = getAddress(decoded.args.from);
    const to = getAddress(decoded.args.to);
    const value = decoded.args.value;
    if (
      value < 0n ||
      log.logIndex === null ||
      !Number.isSafeInteger(log.logIndex) ||
      log.logIndex < 0
    ) {
      throw new Error("Trade Transfer log identity is invalid.");
    }
    if (address === sellToken) {
      if (from === wallet) {
        sellOut += value;
        sellIndexes.push(log.logIndex);
      }
      if (to === wallet) {
        sellIn += value;
        sellIndexes.push(log.logIndex);
      }
    } else {
      if (to === wallet) {
        buyIn += value;
        buyIndexes.push(log.logIndex);
      }
      if (from === wallet) {
        buyOut += value;
        buyIndexes.push(log.logIndex);
      }
    }
  }
  const actualSell = receipt.status === "success" ? sellOut - sellIn : 0n;
  const actualBuy = receipt.status === "success" ? buyIn - buyOut : 0n;
  if (actualSell < 0n || actualBuy < 0n) {
    throw new Error("Trade transfer accounting produced a negative net quantity.");
  }
  if (receipt.status === "success" && (actualSell !== reservedSell || actualBuy <= 0n)) {
    throw new Error(
      "Successful trade receipt does not prove the exact reserved sell amount and a positive buy amount.",
    );
  }
  if (
    receipt.status === "reverted" &&
    (sellOut !== 0n || sellIn !== 0n || buyIn !== 0n || buyOut !== 0n)
  ) {
    throw new Error("Reverted transaction unexpectedly contains token principal transfers.");
  }
  const proof: VerifiedTradeSettlement = Object.freeze({
    executionId: request.executionId,
    chainId: 137,
    transactionHash: txHash,
    nonce: transaction.nonce,
    status: receipt.status === "success" ? "confirmed" : "reverted",
    walletAddress: wallet,
    sellToken,
    buyToken,
    transactionTarget: target,
    transactionData: request.transactionData,
    transactionValueWei: request.transactionValueWei,
    reservedSellAmountBaseUnits: reservedSell.toString(),
    actualSellAmountBaseUnits: actualSell.toString(),
    actualBuyAmountBaseUnits: actualBuy.toString(),
    gasWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash.toLowerCase() as Hash,
    confirmations,
    requiredConfirmations: request.requiredConfirmations,
    sellTransferLogIndexes: Object.freeze(sellIndexes),
    buyTransferLogIndexes: Object.freeze(buyIndexes),
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPriceWei: receipt.effectiveGasPrice.toString(),
  });
  issuedProofs.add(proof);
  return proof;
}
