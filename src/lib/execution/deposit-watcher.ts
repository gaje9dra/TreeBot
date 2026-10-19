import {
  decodeEventLog,
  decodeFunctionData,
  getAddress,
  isAddress,
  parseAbi,
  type Address,
  type Hash,
  type Hex,
} from "viem";

const erc20TransferAbi = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export interface DepositReceiptLog {
  address: Address;
  data: Hex;
  topics: readonly Hex[];
  logIndex: number | null;
}
export interface DepositReceipt {
  transactionHash: Hash;
  status: "success" | "reverted";
  blockNumber: bigint | null;
  blockHash: Hash | null;
  logs: readonly DepositReceiptLog[];
}
export interface DepositTransaction {
  hash: Hash;
  from: Address;
  to: Address | null;
  input: Hex;
}
export interface DepositChainReader {
  getChainId(): Promise<number>;
  getTransactionReceipt(args: { hash: Hash }): Promise<DepositReceipt>;
  getTransaction(args: { hash: Hash }): Promise<DepositTransaction>;
  getBlockNumber(): Promise<bigint>;
  getBlock(args: { blockNumber: bigint }): Promise<{ number: bigint; hash: Hash; parentHash: Hash }>;
}
export interface DepositStore {
  recordDepositEvent(input: {
    accountId: string;
    token: string;
    amount: string;
    from: string;
    to: string;
    txHash: string;
    logIndex: number;
    blockNumber: string;
    confirmed: boolean;
    confirmations: number;
    requiredConfirmations: number;
  }): Promise<{ credited: boolean }>;
}
export interface VerifyDepositRequest {
  transactionHash: string;
  accountAddress: string;
  tokenAddress: string;
  vaultAddress: string;
  minimumAmount: string;
  /** Must be a token explicitly enabled in the deployment configuration. */
  supportedTokenAddresses: readonly string[];
}

export class DepositVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DepositVerificationError";
  }
}

/**
 * Verifies a direct ERC-20 transfer to the configured vault against the transaction,
 * canonical receipt, token contract and Transfer log before invoking the idempotent
 * ledger writer. transferFrom, routers and arbitrary calldata are deliberately rejected.
 */
export class TrustedDepositWatcher {
  constructor(
    private readonly chain: DepositChainReader,
    private readonly store: DepositStore,
    private readonly requiredConfirmations = 64,
  ) {
    if (!Number.isInteger(requiredConfirmations) || requiredConfirmations < 1 || requiredConfirmations > 10_000) {
      throw new Error("requiredConfirmations must be an integer from 1 to 10000.");
    }
  }

  async verifyAndCredit(request: VerifyDepositRequest): Promise<{ credited: boolean; amount: string; confirmations: number }> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(request.transactionHash)) throw new DepositVerificationError("Invalid transaction hash.");
    if (![request.accountAddress, request.tokenAddress, request.vaultAddress].every((address) => isAddress(address))) {
      throw new DepositVerificationError("Invalid account, token or vault address.");
    }
    if (!/^[1-9][0-9]*$/.test(request.minimumAmount)) throw new DepositVerificationError("Minimum amount must be positive base units.");

    const account = getAddress(request.accountAddress);
    const token = getAddress(request.tokenAddress);
    const vault = getAddress(request.vaultAddress);
    if (!request.supportedTokenAddresses.some((configured) => isAddress(configured) && getAddress(configured) === token)) {
      throw new DepositVerificationError("Token is not in the configured deposit allowlist.");
    }
    const hash = request.transactionHash as Hash;

    if (await this.chain.getChainId() !== 137) throw new DepositVerificationError("Deposits are accepted only on Polygon chain ID 137.");
    const [receipt, transaction, currentBlock] = await Promise.all([
      this.chain.getTransactionReceipt({ hash }),
      this.chain.getTransaction({ hash }),
      this.chain.getBlockNumber(),
    ]);
    if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || transaction.hash.toLowerCase() !== hash.toLowerCase()) {
      throw new DepositVerificationError("RPC returned a mismatched transaction identity.");
    }
    if (receipt.status !== "success" || receipt.blockNumber === null || !receipt.blockHash) {
      throw new DepositVerificationError("Deposit transaction is pending, failed or has no mined block hash.");
    }
    const canonicalBlock = await this.chain.getBlock({ blockNumber: receipt.blockNumber });
    if (
      canonicalBlock.number !== receipt.blockNumber ||
      canonicalBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase()
    ) {
      throw new DepositVerificationError("Deposit receipt block is not canonical.");
    }
    if (transaction.to === null || getAddress(transaction.to) !== token) {
      throw new DepositVerificationError("Only a direct ERC-20 transfer to the configured token contract is supported.");
    }
    if (getAddress(transaction.from) !== account) {
      throw new DepositVerificationError("Transaction sender does not match the depositing account.");
    }

    let decodedCall: ReturnType<typeof decodeFunctionData>;
    try {
      decodedCall = decodeFunctionData({ abi: erc20TransferAbi, data: transaction.input });
    } catch {
      throw new DepositVerificationError("Unsupported deposit calldata; only ERC-20 transfer(address,uint256) is accepted.");
    }
    if (decodedCall.functionName !== "transfer") throw new DepositVerificationError("Unsupported deposit method.");
    const [callRecipient, callAmount] = decodedCall.args as readonly [Address, bigint];
    if (getAddress(callRecipient) !== vault || callAmount < BigInt(request.minimumAmount)) {
      throw new DepositVerificationError("Transaction calldata recipient or amount does not satisfy the deposit request.");
    }

    const matchingLogs: Array<{ from: Address; to: Address; value: bigint; logIndex: number }> = [];
    for (const log of receipt.logs) {
      if (!isAddress(log.address) || getAddress(log.address) !== token || log.logIndex === null) continue;
      try {
        const decoded = decodeEventLog({ abi: erc20TransferAbi, eventName: "Transfer", data: log.data, topics: [...log.topics] as [Hex, ...Hex[]] });
        const args = decoded.args as { from: Address; to: Address; value: bigint };
        if (getAddress(args.from) === account && getAddress(args.to) === vault && args.value === callAmount) {
          matchingLogs.push({ ...args, logIndex: log.logIndex });
        }
      } catch {
        // Non-Transfer logs do not establish a deposit.
      }
    }
    if (matchingLogs.length !== 1) {
      throw new DepositVerificationError("Expected exactly one matching ERC-20 Transfer event in the successful receipt.");
    }

    const confirmationsBig = currentBlock >= receipt.blockNumber ? currentBlock - receipt.blockNumber + 1n : 0n;
    const confirmations = Number(confirmationsBig > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : confirmationsBig);
    if (confirmations < this.requiredConfirmations) {
      throw new DepositVerificationError(`Deposit has ${confirmations} confirmations; ${this.requiredConfirmations} are required.`);
    }

    const event = matchingLogs[0]!;
    const result = await this.store.recordDepositEvent({
      accountId: account,
      token,
      amount: event.value.toString(),
      from: event.from,
      to: event.to,
      txHash: hash,
      logIndex: event.logIndex,
      blockNumber: receipt.blockNumber.toString(),
      confirmed: true,
      confirmations,
      requiredConfirmations: this.requiredConfirmations,
    });
    return { credited: result.credited, amount: event.value.toString(), confirmations };
  }
}
