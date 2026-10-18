import { isAddress, getAddress, type Address, type Hash } from "viem";
import type { ValidatedSwapQuote, ZeroExPolygonQuoteAdapter } from "./zero-ex";
import type { PolygonExecutionReadClient, TransactionSimulation, ReceiptSettlement } from "./evm-client";
import type { PostgresExecutionStore } from "./postgres";
import { authorizeExecution, assertLiveExecutionUnavailable, type ExecutionAuthorization } from "./authorization";

export interface ExecutionRiskState {
  emergencyStop: boolean;
  tradingEnabled: boolean;
  maximumSlippageBps: number;
  allowedTokens: readonly string[];
  allowedTargets: readonly string[];
}
export interface ExecutionIntentRequest {
  id: string;
  idempotencyKey: string;
  owner: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  slippageBps: number;
  authorization: ExecutionAuthorization;
}
export interface PreparedExecution {
  quote: ValidatedSwapQuote;
  simulation: TransactionSimulation;
  recordId: string;
  status: "prepared" | "already-recorded";
}
export interface ExecutionDependencies {
  quotes: ZeroExPolygonQuoteAdapter;
  chain: PolygonExecutionReadClient;
  store: PostgresExecutionStore;
  loadRiskState: () => Promise<ExecutionRiskState>;
  submitAuthorized?: (simulation: TransactionSimulation, authorization: ExecutionAuthorization) => Promise<{ hash: Hash; nonce: number }>;
  now?: () => number;
}

/**
 * Prepare transaction end-to-end, persist its idempotency reservation, and simulate it.
 * This service intentionally cannot broadcast unless a separately injected, reviewed
 * execution mechanism is supplied. There is no general-purpose backend private key.
 */
export class PolygonExecutionPipeline {
  constructor(private readonly dependencies: ExecutionDependencies) {}

  async prepare(request: ExecutionIntentRequest): Promise<PreparedExecution> {
    if (![request.owner,request.sellToken,request.buyToken].every(isAddress)) throw new Error("Invalid execution address.");
    const owner = getAddress(request.owner);
    const sellToken = getAddress(request.sellToken);
    const buyToken = getAddress(request.buyToken);
    const risk = await this.dependencies.loadRiskState();
    if (!risk.tradingEnabled || risk.emergencyStop) throw new Error("Execution is paused by the risk control.");
    if (request.slippageBps > risk.maximumSlippageBps) throw new Error("Requested slippage exceeds current risk policy.");
    if (!risk.allowedTokens.some((v) => isAddress(v) && getAddress(v) === sellToken) ||
        !risk.allowedTokens.some((v) => isAddress(v) && getAddress(v) === buyToken)) throw new Error("Token not allowed by current risk policy.");

    const quote = await this.dependencies.quotes.getFirmQuote({
      chainId:137, sellToken, buyToken, sellAmount:request.sellAmount, taker:owner, slippageBps:request.slippageBps,
    });
    if (!risk.allowedTargets.some((v) => isAddress(v) && getAddress(v) === quote.transaction.to)) throw new Error("Quote target not allowed by current risk policy.");
    const auth = authorizeExecution(request.authorization, {
      chainId:137, owner, sellToken, buyToken, sellAmount:request.sellAmount,
      transactionTarget:quote.transaction.to, now:(this.dependencies.now ?? Date.now)(),
    });
    if (!auth.allowed) throw new Error(`Execution authorization rejected: ${auth.reason}`);
    const preparedTransaction = {
      chainId:quote.chainId, from:owner, to:quote.transaction.to, data:quote.transaction.data,
      value:quote.transaction.value.toString(), gas:quote.transaction.gas?.toString() ?? null,
      gasPrice:quote.transaction.gasPrice?.toString() ?? null,
    };
    const reserved = await this.dependencies.store.createOrGetIntent({
      id:request.id, idempotencyKey:request.idempotencyKey, walletAddress:owner, sellToken, buyToken,
      sellAmount:request.sellAmount,
      quote:{...quote, sellAmount:quote.sellAmount.toString(), buyAmount:quote.buyAmount.toString(), minBuyAmount:quote.minBuyAmount.toString(),
        transaction:{...quote.transaction,value:quote.transaction.value.toString(),gas:quote.transaction.gas?.toString() ?? null,gasPrice:quote.transaction.gasPrice?.toString() ?? null}},
      authorizationId:request.authorization.id, riskChecks:{tradingEnabled:risk.tradingEnabled,emergencyStop:risk.emergencyStop,
        maximumSlippageBps:risk.maximumSlippageBps,checkedAt:(this.dependencies.now ?? Date.now)()},
      preparedTransaction,
    });
    if (!reserved.created) return { quote, simulation: await this.dependencies.chain.simulateExactSwap(quote, owner),
      recordId:reserved.record.id, status:"already-recorded" };
    try {
      // A database reservation precedes simulation, so crashes are recoverable by idempotency key.
      const simulation = await this.dependencies.chain.simulateExactSwap(quote, owner);
      return { quote, simulation, recordId:reserved.record.id, status:"prepared" };
    } catch (error) {
      // Leave intent durably recorded for investigation; a failed simulation is never sent.
      throw new Error(`Transaction simulation failed; intent ${reserved.record.id} retained and not submitted: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  async submitPrepared(
    prepared: PreparedExecution,
    request: ExecutionIntentRequest,
  ): Promise<{ hash: Hash; nonce: number }> {
    // Re-read every dynamic risk gate immediately before submission.
    const risk = await this.dependencies.loadRiskState();
    if (!risk.tradingEnabled || risk.emergencyStop) throw new Error("Submission blocked: trading disabled or emergency stop active.");
    if (!this.dependencies.submitAuthorized) return assertLiveExecutionUnavailable();
    const auth = authorizeExecution(request.authorization, {
      chainId:137, owner:request.owner, sellToken:request.sellToken, buyToken:request.buyToken,
      sellAmount:request.sellAmount, transactionTarget:prepared.quote.transaction.to, now:(this.dependencies.now ?? Date.now)(),
    });
    if (!auth.allowed) throw new Error(`Submission authorization rejected: ${auth.reason}`);
    if (prepared.quote.slippageBps > risk.maximumSlippageBps ||
        !risk.allowedTargets.some((v) => isAddress(v) && getAddress(v) === prepared.quote.transaction.to)) {
      throw new Error("Submission blocked by current target/slippage policy.");
    }
    // Only an explicitly injected authorized mechanism may sign/send. No blind retry here.
    const result = await this.dependencies.submitAuthorized(prepared.simulation, request.authorization);
    try {
      await this.dependencies.store.recordBroadcast(prepared.recordId, "authorized-submit-adapter", result.hash, result.nonce);
    } catch (error) {
      // Broadcast may already have succeeded: mark ambiguous and require chain reconciliation.
      await this.dependencies.store.recordSubmissionUnknown(prepared.recordId,
        `Broadcast returned hash but persistence failed: ${error instanceof Error ? error.message : "unknown persistence error"}; hash=${result.hash}`);
      throw new Error("Submission persistence is indeterminate. Do not retry; reconcile the recorded/observed chain transaction.");
    }
    return result;
  }

  async reconcileReceipt(recordId: string, settlement: ReceiptSettlement, actualSellAmount: string, actualBuyAmount: string): Promise<void> {
    await this.dependencies.store.recordSettlement({
      id:recordId,status:settlement.status,blockNumber:settlement.blockNumber.toString(),
      actualSellAmount,actualBuyAmount,gasWei:settlement.gasCostWei.toString(),
    });
  }
}
