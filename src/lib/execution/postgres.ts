import type { Pool } from "pg";
import type { TransactionStatus } from "./lifecycle";
import { assertNonNegativeBaseUnits, assertPositiveBaseUnits } from "./amounts";

export interface ExecutionIntentInput {
  id: string; idempotencyKey: string; walletAddress: string; sellToken: string; buyToken: string;
  sellAmount: string; quote: Record<string, unknown>; authorizationId: string;
  riskChecks: Record<string, unknown>; preparedTransaction: Record<string, unknown>;
}
export interface StoredExecutionIntent extends ExecutionIntentInput {
  status: TransactionStatus; txHash: string | null; nonce: number | null;
}

function toRecord(row: Record<string, unknown>): StoredExecutionIntent {
  return { id: String(row.id), idempotencyKey: String(row.idempotency_key), walletAddress: String(row.wallet_address),
    sellToken: String(row.sell_token), buyToken: String(row.buy_token), sellAmount: String(row.sell_amount),
    quote: row.quote as Record<string, unknown>, authorizationId: String(row.authorization_id),
    riskChecks: row.risk_checks as Record<string, unknown>, preparedTransaction: row.prepared_transaction as Record<string, unknown>,
    status: row.status as TransactionStatus, txHash: row.tx_hash ? String(row.tx_hash) : null,
    nonce: row.nonce === null || row.nonce === undefined ? null : Number(row.nonce) };
}

export class PostgresExecutionStore {
  constructor(private readonly pool: Pool) {}

  /** Reserve the idempotency key durably before any signer/broadcaster can act. */
  async createOrGetIntent(input: ExecutionIntentInput): Promise<{ record: StoredExecutionIntent; created: boolean }> {
    if (!input.id.trim() || !input.idempotencyKey.trim()) throw new Error("Intent ID and idempotency key are required.");
    if (input.sellToken.toLowerCase() === input.buyToken.toLowerCase()) throw new Error("Sell and buy token must differ.");
    assertPositiveBaseUnits(input.sellAmount, "sell amount");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const insert = await client.query(
        `INSERT INTO execution_transactions
         (id,idempotency_key,chain_id,wallet_address,sell_token,buy_token,side,sell_amount,quote,authorization_id,risk_checks,prepared_transaction,status)
         VALUES ($1,$2,137,$3,$4,$5,'sell',$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,'prepared')
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
        [input.id,input.idempotencyKey,input.walletAddress,input.sellToken,input.buyToken,input.sellAmount,
          JSON.stringify(input.quote),input.authorizationId,JSON.stringify(input.riskChecks),JSON.stringify(input.preparedTransaction)]);
      const created = insert.rowCount === 1;
      const result = created ? insert : await client.query(
        "SELECT * FROM execution_transactions WHERE idempotency_key=$1 FOR UPDATE", [input.idempotencyKey]);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new Error("Idempotency reservation disappeared.");
      const record = toRecord(row);
      await client.query("INSERT INTO execution_audit_events (transaction_id,event_type,details) VALUES ($1,$2,$3::jsonb)",
        [record.id,created ? "intent_reserved" : "idempotent_replay",JSON.stringify({ idempotencyKey: input.idempotencyKey })]);
      await client.query("COMMIT");
      return { record, created };
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  /** Lease one item for a worker without allowing two workers to prepare it simultaneously. */
  async leasePreparedIntent(workerId: string, leaseMs = 30_000): Promise<StoredExecutionIntent | null> {
    if (!workerId.trim() || !Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) throw new Error("Invalid worker lease.");
    const result = await this.pool.query(
      `WITH candidate AS (
         SELECT id FROM execution_transactions
         WHERE status='prepared' AND (lease_expires_at IS NULL OR lease_expires_at<NOW())
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE execution_transactions t SET lease_owner=$1,
        lease_expires_at=NOW()+($2::text || ' milliseconds')::interval,updated_at=NOW()
       FROM candidate c WHERE t.id=c.id RETURNING t.*`, [workerId,leaseMs]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? toRecord(row) : null;
  }

  async recordBroadcast(id: string, workerId: string, txHash: string, nonce: number): Promise<void> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash) || !Number.isSafeInteger(nonce) || nonce < 0) throw new Error("Invalid broadcast hash or nonce.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE execution_transactions SET tx_hash=$3,nonce=$4,status='submitted',updated_at=NOW(),lease_owner=NULL,lease_expires_at=NULL
         WHERE id=$1 AND lease_owner=$2 AND status='prepared' RETURNING id`, [id,workerId,txHash.toLowerCase(),nonce]);
      if (updated.rowCount !== 1) throw new Error("Intent is not leased by this worker or is no longer prepared.");
      await client.query("INSERT INTO execution_audit_events (transaction_id,event_type,details) VALUES ($1,'broadcast_recorded',$2::jsonb)",
        [id,JSON.stringify({ txHash: txHash.toLowerCase(),nonce })]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  async recordSubmissionUnknown(id: string, message: string): Promise<void> {
    const safeMessage = message.slice(0,500);
    await this.pool.query(
      `UPDATE execution_transactions SET status='unknown',error_code='SUBMISSION_UNKNOWN',error_message=$2,updated_at=NOW()
       WHERE id=$1 AND status IN ('prepared','signed','submitted','pending')`, [id,safeMessage]);
    await this.pool.query("INSERT INTO execution_audit_events (transaction_id,event_type,details) VALUES ($1,'submission_unknown',$2::jsonb)",
      [id,JSON.stringify({ message: safeMessage,retryAllowed: false })]);
  }

  async recordSettlement(input: { id: string; status: "confirmed" | "reverted"; blockNumber: string; actualSellAmount: string; actualBuyAmount: string; gasWei: string }): Promise<void> {
    assertNonNegativeBaseUnits(input.actualSellAmount,"actual sell amount");
    assertNonNegativeBaseUnits(input.actualBuyAmount,"actual buy amount");
    assertNonNegativeBaseUnits(input.gasWei,"gas");
    if (!/^[1-9][0-9]*$/.test(input.blockNumber)) throw new Error("Invalid settlement block number.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE execution_transactions SET status=$2,confirmation_block=$3,actual_sell_amount=$4,actual_buy_amount=$5,actual_gas_wei=$6,
         confirmed_at=CASE WHEN $2='confirmed' THEN NOW() ELSE NULL END,updated_at=NOW()
         WHERE id=$1 AND status IN ('submitted','pending','unknown','replaced') RETURNING id`,
        [input.id,input.status,input.blockNumber,input.actualSellAmount,input.actualBuyAmount,input.gasWei]);
      if (updated.rowCount !== 1) throw new Error("Transaction is not eligible for settlement reconciliation.");
      await client.query("INSERT INTO execution_audit_events (transaction_id,event_type,details) VALUES ($1,'settlement_reconciled',$2::jsonb)",
        [input.id,JSON.stringify(input)]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  async reconcileWallet(input: { walletAddress: string; token: string; chainBalance: string; ledgerBalance: string }): Promise<{ matched: boolean; discrepancy: string }> {
    const chain = assertNonNegativeBaseUnits(input.chainBalance,"chain balance");
    const ledger = assertNonNegativeBaseUnits(input.ledgerBalance,"ledger balance");
    const discrepancy = chain-ledger;
    const matched = discrepancy === 0n;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO execution_reconciliation (wallet_address,token_address,chain_balance,ledger_balance,discrepancy,status,reconciled_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
        [input.walletAddress,input.token,chain.toString(),ledger.toString(),discrepancy.toString(),matched ? "matched" : "mismatch"]);
      if (!matched) {
        await client.query("UPDATE execution_control SET emergency_stop=TRUE,mismatch_detected_at=NOW() WHERE id=1");
        await client.query("INSERT INTO execution_audit_events (event_type,details) VALUES ('balance_mismatch',$1::jsonb)",
          [JSON.stringify({ walletAddress:input.walletAddress,token:input.token,chainBalance:chain.toString(),ledgerBalance:ledger.toString(),discrepancy:discrepancy.toString() })]);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
    return { matched, discrepancy: discrepancy.toString() };
  }
}
