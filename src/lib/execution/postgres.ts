import type { Pool } from "pg";
import type { Address } from "viem";
import type { DepositLifecycleRecord, DepositScannerStore } from "./deposit-scanner";
import type { TransactionStatus } from "./lifecycle";
import { assertNonNegativeBaseUnits, assertPositiveBaseUnits } from "./amounts";

export interface ExecutionIntentInput {
  id:string; idempotencyKey:string; walletAddress:string; sellToken:string; buyToken:string; sellAmount:string;
  quote:Record<string,unknown>; authorizationId:string; riskChecks:Record<string,unknown>; preparedTransaction:Record<string,unknown>;
}
export interface StoredExecutionIntent extends ExecutionIntentInput { status:TransactionStatus; txHash:string|null; nonce:number|null; }
function toRecord(row:Record<string,unknown>):StoredExecutionIntent{
  return {id:String(row.id),idempotencyKey:String(row.idempotency_key),walletAddress:String(row.wallet_address),
    sellToken:String(row.sell_token),buyToken:String(row.buy_token),sellAmount:String(row.sell_amount),
    quote:row.quote as Record<string,unknown>,authorizationId:String(row.authorization_id),riskChecks:row.risk_checks as Record<string,unknown>,
    preparedTransaction:row.prepared_transaction as Record<string,unknown>,status:row.status as TransactionStatus,
    txHash:row.tx_hash?String(row.tx_hash):null,nonce:row.nonce===null||row.nonce===undefined?null:Number(row.nonce)};
}
export class PostgresExecutionStore {
  constructor(private readonly pool:Pool){}
  async createOrGetIntent(input:ExecutionIntentInput):Promise<{record:StoredExecutionIntent;created:boolean}>{
    if(!input.id.trim()||!input.idempotencyKey.trim())throw new Error("Intent ID and idempotency key are required.");
    if(input.sellToken.toLowerCase()===input.buyToken.toLowerCase())throw new Error("Sell and buy token must differ.");
    assertPositiveBaseUnits(input.sellAmount,"sell amount");
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const inserted=await c.query(`INSERT INTO execution_transactions
        (id,idempotency_key,chain_id,wallet_address,sell_token,buy_token,side,sell_amount,quote,authorization_id,risk_checks,prepared_transaction,status)
        VALUES($1,$2,137,$3,$4,$5,'sell',$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,'prepared')
        ON CONFLICT(idempotency_key) DO NOTHING RETURNING *`,
        [input.id,input.idempotencyKey,input.walletAddress,input.sellToken,input.buyToken,input.sellAmount,
          JSON.stringify(input.quote),input.authorizationId,JSON.stringify(input.riskChecks),JSON.stringify(input.preparedTransaction)]);
      const created=inserted.rowCount===1;
      const res=created?inserted:await c.query("SELECT * FROM execution_transactions WHERE idempotency_key=$1 FOR UPDATE",[input.idempotencyKey]);
      const row=res.rows[0] as Record<string,unknown>|undefined;if(!row)throw new Error("Idempotency reservation disappeared.");
      const record=toRecord(row);
      await c.query("INSERT INTO execution_audit_events(transaction_id,event_type,details) VALUES($1,$2,$3::jsonb)",
        [record.id,created?"intent_reserved":"idempotent_replay",JSON.stringify({idempotencyKey:input.idempotencyKey})]);
      await c.query("COMMIT");return {record,created};
    }catch(e){await c.query("ROLLBACK").catch(()=>undefined);throw e;}finally{c.release();}
  }
  async leasePreparedIntent(workerId:string,leaseMs=30_000):Promise<StoredExecutionIntent|null>{
    if(!workerId.trim()||!Number.isInteger(leaseMs)||leaseMs<1000||leaseMs>300_000)throw new Error("Invalid worker lease.");
    const r=await this.pool.query(`WITH candidate AS (
      SELECT id FROM execution_transactions
      WHERE status='prepared' AND (lease_expires_at IS NULL OR lease_expires_at<NOW())
        AND EXISTS (SELECT 1 FROM execution_control WHERE id=1 AND emergency_stop=FALSE)
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE execution_transactions t SET lease_owner=$1,lease_expires_at=NOW()+($2::text||' milliseconds')::interval,updated_at=NOW()
      FROM candidate c WHERE t.id=c.id RETURNING t.*`,[workerId,leaseMs]);
    const row=r.rows[0] as Record<string,unknown>|undefined;return row?toRecord(row):null;
  }
  async recordBroadcast(id:string,workerId:string,txHash:string,nonce:number):Promise<void>{
    if(!/^0x[0-9a-fA-F]{64}$/.test(txHash)||!Number.isSafeInteger(nonce)||nonce<0)throw new Error("Invalid broadcast hash or nonce.");
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const u=await c.query(`UPDATE execution_transactions SET tx_hash=$3,nonce=$4,status='submitted',updated_at=NOW(),lease_owner=NULL,lease_expires_at=NULL
        WHERE id=$1 AND lease_owner=$2 AND status='prepared' RETURNING id`,[id,workerId,txHash.toLowerCase(),nonce]);
      if(u.rowCount!==1)throw new Error("Intent is not leased by this worker or is no longer prepared.");
      await c.query("INSERT INTO execution_audit_events(transaction_id,event_type,details) VALUES($1,'broadcast_recorded',$2::jsonb)",
        [id,JSON.stringify({txHash:txHash.toLowerCase(),nonce})]);
      await c.query("COMMIT");
    }catch(e){await c.query("ROLLBACK").catch(()=>undefined);throw e;}finally{c.release();}
  }
  async recordSubmissionUnknown(id:string,message:string):Promise<void>{
    const m=message.slice(0,500);
    await this.pool.query(`UPDATE execution_transactions SET status='unknown',error_code='SUBMISSION_UNKNOWN',error_message=$2,updated_at=NOW()
      WHERE id=$1 AND status IN ('prepared','signed','submitted','pending')`,[id,m]);
    await this.pool.query("INSERT INTO execution_audit_events(transaction_id,event_type,details) VALUES($1,'submission_unknown',$2::jsonb)",
      [id,JSON.stringify({message:m,retryAllowed:false})]);
  }
  async recordSettlement(input:{id:string;status:"confirmed"|"reverted";blockNumber:string;actualSellAmount:string;actualBuyAmount:string;gasWei:string;realizedPnlBaseUnits?:string;quoteFeeBaseUnits?:string}):Promise<void>{
    assertNonNegativeBaseUnits(input.actualSellAmount,"actual sell amount");assertNonNegativeBaseUnits(input.actualBuyAmount,"actual buy amount");
    assertNonNegativeBaseUnits(input.gasWei,"gas");
    if(input.realizedPnlBaseUnits!==undefined&&!/^-?(0|[1-9][0-9]*)$/.test(input.realizedPnlBaseUnits))throw new Error("Invalid realized P&L base-unit value.");
    if(input.quoteFeeBaseUnits!==undefined)assertNonNegativeBaseUnits(input.quoteFeeBaseUnits,"quote fee");
    if(!/^[1-9][0-9]*$/.test(input.blockNumber))throw new Error("Invalid settlement block number.");
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const u=await c.query(`UPDATE execution_transactions SET status=$2,confirmation_block=$3,actual_sell_amount=$4,actual_buy_amount=$5,actual_gas_wei=$6,
        confirmed_at=CASE WHEN $2='confirmed' THEN NOW() ELSE NULL END,updated_at=NOW()
        WHERE id=$1 AND status IN ('submitted','pending','unknown','replaced') RETURNING id`,
        [input.id,input.status,input.blockNumber,input.actualSellAmount,input.actualBuyAmount,input.gasWei]);
      if(u.rowCount!==1)throw new Error("Transaction is not eligible for settlement reconciliation.");
      await c.query("INSERT INTO execution_audit_events(transaction_id,event_type,details) VALUES($1,'settlement_reconciled',$2::jsonb)",[input.id,JSON.stringify(input)]);
      if(input.status==="confirmed"){
        const q=await c.query("SELECT tx_hash,wallet_address,sell_token,buy_token FROM execution_transactions WHERE id=$1",[input.id]);
        const row=q.rows[0];if(!row?.tx_hash)throw new Error("Confirmed settlement requires transaction hash.");
        await c.query(`INSERT INTO execution_ledger_entries(account_id,event_key,entry_type,asset_address,amount_base_units,chain_id,transaction_hash,details)
          VALUES($1,$2,'trade_sell',$3,-$4::numeric,137,$5,$6::jsonb),($1,$7,'trade_buy',$8,$9,137,$5,$6::jsonb),($1,$10,'gas','0x0000000000000000000000000000000000000000',-$11::numeric,137,$5,$6::jsonb)
          ON CONFLICT(event_key) DO NOTHING`,
          [row.wallet_address,`${row.tx_hash}:sell`,row.sell_token,input.actualSellAmount,row.tx_hash,JSON.stringify({executionId:input.id}),
            `${row.tx_hash}:buy`,row.buy_token,input.actualBuyAmount,`${row.tx_hash}:gas`,input.gasWei]);
        if(input.realizedPnlBaseUnits!==undefined&&input.realizedPnlBaseUnits!=="0"){
          await c.query(`INSERT INTO execution_ledger_entries(account_id,event_key,entry_type,asset_address,amount_base_units,chain_id,transaction_hash,details)
            VALUES($1,$2,'realized_pnl',$3,$4,137,$5,$6::jsonb) ON CONFLICT(event_key) DO NOTHING`,
            [row.wallet_address,`${row.tx_hash}:realized-pnl`,row.buy_token,input.realizedPnlBaseUnits,row.tx_hash,JSON.stringify({executionId:input.id})]);
        }
        if(input.quoteFeeBaseUnits!==undefined&&input.quoteFeeBaseUnits!=="0"){
          await c.query(`INSERT INTO execution_ledger_entries(account_id,event_key,entry_type,asset_address,amount_base_units,chain_id,transaction_hash,details)
            VALUES($1,$2,'fee',$3,-$4::numeric,137,$5,$6::jsonb) ON CONFLICT(event_key) DO NOTHING`,
            [row.wallet_address,`${row.tx_hash}:fee`,row.buy_token,input.quoteFeeBaseUnits,row.tx_hash,JSON.stringify({executionId:input.id})]);
        }
      }
      await c.query("COMMIT");
    }catch(e){await c.query("ROLLBACK").catch(()=>undefined);throw e;}finally{c.release();}
  }
  /**
   * Direct caller-supplied deposit records are never sufficient proof of funds.
   * This remains disabled even when the scanner has observed a matching event:
   * only a separately designed proof-bearing credit API may write spendable funds.
   */
  async recordDepositEvent(_input: {
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
    requiredConfirmations?: number;
  }): Promise<{ credited: boolean }> {
    throw new Error("Deposit credit is disabled until trusted durable chain-proof verification is configured.");
  }
  /** Serialize reserve operations so concurrent withdrawals cannot overspend the same ledger balance. */
  async reserveWithdrawal(input:{id:string;accountId:string;token:string;recipient:string;amount:string;idempotencyKey:string}):Promise<{reserved:boolean}>{
    const amount=assertPositiveBaseUnits(input.amount,"withdrawal amount");
    if(!/^0x[0-9a-fA-F]{40}$/.test(input.token)||!/^0x[0-9a-fA-F]{40}$/.test(input.recipient))throw new Error("Invalid withdrawal token or recipient address.");
    if(!input.accountId.trim()||!input.idempotencyKey.trim()||!input.id.trim())throw new Error("Withdrawal reservation identity is required.");
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      // Serialize all reservations for a given account/asset, including the empty-ledger case.
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",[input.accountId,input.token.toLowerCase()]);
      const control=await c.query("SELECT emergency_stop FROM execution_control WHERE id=1 FOR UPDATE");
      if(!control.rows[0]||control.rows[0].emergency_stop!==false)throw new Error("Withdrawal blocked by execution emergency stop.");
      const duplicate=await c.query("SELECT id FROM execution_withdrawal_reservations WHERE idempotency_key=$1 FOR UPDATE",[input.idempotencyKey]);
      if(duplicate.rowCount){await c.query("COMMIT");return {reserved:false};}
      const existing=await c.query("SELECT id FROM execution_withdrawal_reservations WHERE id=$1 OR idempotency_key=$2",[input.id,input.idempotencyKey]);
      if(existing.rowCount)throw new Error("Withdrawal ID or idempotency key already belongs to another reservation.");
      // These are journal primitives only. Reject withdrawal while the last reconciliation is
      // missing or mismatched; callers must reconcile on-chain balance before reserving funds.
      const recon=await c.query("SELECT status FROM execution_reconciliation WHERE LOWER(wallet_address)=LOWER($1) AND LOWER(token_address)=LOWER($2) ORDER BY reconciled_at DESC LIMIT 1",[input.accountId,input.token]);
      if(recon.rows[0]?.status!=="matched")throw new Error("Withdrawal blocked until chain-to-ledger reconciliation is matched.");
      const balance=await c.query("SELECT COALESCE(SUM(amount_base_units),0)::text AS v FROM execution_ledger_entries WHERE account_id=$1 AND LOWER(asset_address)=LOWER($2)",[input.accountId,input.token]);
      const held=await c.query("SELECT COALESCE(SUM(amount_base_units),0)::text AS v FROM execution_withdrawal_reservations WHERE account_id=$1 AND LOWER(asset_address)=LOWER($2) AND status IN('reserved','submitted','unknown')",[input.accountId,input.token]);
      const available=BigInt(balance.rows[0]?.v??"0")-BigInt(held.rows[0]?.v??"0");if(available<0n||amount>available)throw new Error("Withdrawal exceeds withdrawable ledger balance.");
      await c.query(`INSERT INTO execution_withdrawal_reservations(id,account_id,asset_address,recipient_address,amount_base_units,status,idempotency_key)
        VALUES($1,$2,$3,$4,$5,'reserved',$6)`,[input.id,input.accountId,input.token,input.recipient,input.amount,input.idempotencyKey]);
      await c.query("COMMIT");return {reserved:true};
    }catch(e){await c.query("ROLLBACK").catch(()=>undefined);throw e;}finally{c.release();}
  }
  async reconcileWallet(input:{walletAddress:string;token:string;chainBalance:string;ledgerBalance:string}):Promise<{matched:boolean;discrepancy:string}>{
    const chain=assertNonNegativeBaseUnits(input.chainBalance,"chain balance"),ledger=assertNonNegativeBaseUnits(input.ledgerBalance,"ledger balance");
    const discrepancy=chain-ledger,matched=discrepancy===0n,c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      await c.query(`INSERT INTO execution_reconciliation(wallet_address,token_address,chain_balance,ledger_balance,discrepancy,status,reconciled_at)
        VALUES($1,$2,$3,$4,$5,$6,NOW())`,[input.walletAddress,input.token,chain.toString(),ledger.toString(),discrepancy.toString(),matched?"matched":"mismatch"]);
      if(!matched){
        await c.query("UPDATE execution_control SET emergency_stop=TRUE,mismatch_detected_at=NOW() WHERE id=1");
        await c.query("INSERT INTO execution_audit_events(event_type,details) VALUES('balance_mismatch',$1::jsonb)",
          [JSON.stringify({walletAddress:input.walletAddress,token:input.token,chainBalance:chain.toString(),ledgerBalance:ledger.toString(),discrepancy:discrepancy.toString()})]);
      }
      await c.query("COMMIT");
    }catch(e){await c.query("ROLLBACK").catch(()=>undefined);throw e;}finally{c.release();}
    return {matched,discrepancy:discrepancy.toString()};
  }

  /** Read back durable, signed journal totals. Amounts are base units and remain strings. */
  async getLedgerBalance(accountId:string,token:string):Promise<string>{
    if(!accountId.trim()||!/^0x[0-9a-fA-F]{40}$/.test(token))throw new Error("Invalid ledger account or asset address.");
    const r=await this.pool.query(
      "SELECT COALESCE(SUM(amount_base_units),0)::text AS balance FROM execution_ledger_entries WHERE account_id=$1 AND LOWER(asset_address)=LOWER($2)",
      [accountId,token]);
    return String(r.rows[0]?.balance??"0");
  }

  /** A balance is only considered reconciled when chain and ledger quantities match exactly. */
  async getLatestReconciliation(walletAddress:string,token:string):Promise<{status:"matched"|"mismatch"|"unknown";discrepancy:string|null;reconciledAt:string|null}>{
    if(!/^0x[0-9a-fA-F]{40}$/.test(walletAddress)||!/^0x[0-9a-fA-F]{40}$/.test(token))throw new Error("Invalid reconciliation address.");
    const r=await this.pool.query(
      "SELECT status,discrepancy::text,reconciled_at::text FROM execution_reconciliation WHERE LOWER(wallet_address)=LOWER($1) AND LOWER(token_address)=LOWER($2) ORDER BY reconciled_at DESC LIMIT 1",
      [walletAddress,token]);
    const row=r.rows[0];
    if(!row)return {status:"unknown",discrepancy:null,reconciledAt:null};
    return {status:row.status==="matched"?"matched":"mismatch",discrepancy:String(row.discrepancy),reconciledAt:String(row.reconciled_at)};
  }

  async isEmergencyStopActive():Promise<boolean>{
    const r=await this.pool.query("SELECT emergency_stop FROM execution_control WHERE id=1");
    return r.rows.length===0||r.rows[0].emergency_stop!==false;
  }

}


export interface DepositRangeCheckpoint {
  nextBlock: bigint;
  lastScannedBlockHash: `0x${string}` | null;
}

/**
 * Partial PostgreSQL scanner-store implementation for the durable deposit watcher.
 * This implementation fails closed when a credited deposit is later orphaned and its
 * funds have already been allocated. It writes compensating entries and advances the
 * checkpoint only within database transactions.
 */
export class PostgresDepositScannerStore implements DepositScannerStore {
  constructor(private readonly pool: Pool) {}

  async getOrCreateCheckpoint(input: {
    chainId: 137;
    watcherKey: string;
    initialBlock: bigint;
  }): Promise<DepositRangeCheckpoint> {
    if (!input.watcherKey.trim() || input.initialBlock < 0n) throw new Error("Invalid deposit checkpoint configuration.");
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        `INSERT INTO execution_chain_watcher_state(chain_id,watcher_key,next_block)
         VALUES($1,$2,$3) ON CONFLICT(chain_id,watcher_key) DO NOTHING`,
        [input.chainId, input.watcherKey, input.initialBlock.toString()],
      );
      const r = await c.query(
        `SELECT next_block::text,last_scanned_block_hash FROM execution_chain_watcher_state
         WHERE chain_id=$1 AND watcher_key=$2 FOR UPDATE`,
        [input.chainId, input.watcherKey],
      );
      const row = r.rows[0] as {next_block:string;last_scanned_block_hash:string|null}|undefined;
      if (!row) throw new Error("Deposit scanner checkpoint was not created.");
      await c.query("COMMIT");
      return {nextBlock: BigInt(row.next_block), lastScannedBlockHash: row.last_scanned_block_hash as `0x${string}`|null};
    } catch (error) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
  }

  async commitScannedRange(input: {
    chainId: 137;
    watcherKey: string;
    expectedNextBlock: bigint;
    nextBlock: bigint;
    lastScannedBlockHash: `0x${string}`;
    observations: readonly {
      chainId: 137;
      transactionHash: `0x${string}`;
      logIndex: number;
      accountId: string;
      assetAddress: string;
      senderAddress: string;
      vaultAddress: string;
      amountBaseUnits: string;
      blockNumber: string;
      blockHash: `0x${string}`;
      confirmations: number;
      requiredConfirmations: number;
    }[];
  }): Promise<{inserted:number;credited:number;reversed:number}> {
    if (input.nextBlock <= input.expectedNextBlock) throw new Error("Next checkpoint must advance the scan range.");
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const checkpoint = await c.query(
        `SELECT next_block::text FROM execution_chain_watcher_state
         WHERE chain_id=$1 AND watcher_key=$2 FOR UPDATE`,
        [input.chainId, input.watcherKey],
      );
      if (!checkpoint.rows[0] || BigInt(String(checkpoint.rows[0].next_block)) !== input.expectedNextBlock) {
        throw new Error("Deposit checkpoint compare-and-swap failed.");
      }
      let inserted = 0;
      const credited = 0;
      for (const event of input.observations) {
        const amount = assertPositiveBaseUnits(event.amountBaseUnits, "deposit amount");
        const blockNumber = BigInt(event.blockNumber);
        if (event.chainId !== 137 || event.logIndex < 0 || blockNumber < input.expectedNextBlock ||
            blockNumber >= input.nextBlock || event.confirmations < 0 || event.requiredConfirmations < 1 ||
            !event.accountId.trim() || !/^0x[0-9a-fA-F]{40}$/.test(event.assetAddress) ||
            !/^0x[0-9a-fA-F]{40}$/.test(event.senderAddress) || !/^0x[0-9a-fA-F]{40}$/.test(event.vaultAddress) ||
            !/^0x[0-9a-fA-F]{64}$/.test(event.transactionHash) || !/^0x[0-9a-fA-F]{64}$/.test(event.blockHash)) {
          throw new Error("Invalid scanned deposit event.");
        }
        const status = event.confirmations >= event.requiredConfirmations ? "confirmed" : "provisional";
        const upsert = await c.query(
          `INSERT INTO execution_deposit_lifecycle
             (chain_id,watcher_key,transaction_hash,log_index,account_id,asset_address,sender_address,vault_address,
              amount_base_units,block_number,block_hash,status,confirmations,required_confirmations,credited_event_key,updated_at)
           VALUES(137,$1,$2,$3,$4,LOWER($5),LOWER($6),LOWER($7),$8,$9,$10,$11,$12,$13,NULL,NOW())
           ON CONFLICT(chain_id,transaction_hash,log_index) DO UPDATE SET
             confirmations=EXCLUDED.confirmations,status=CASE
               WHEN execution_deposit_lifecycle.status='reversed' THEN 'reversed'
               WHEN execution_deposit_lifecycle.block_hash<>EXCLUDED.block_hash THEN 'reconciliation_required'
               ELSE EXCLUDED.status END,updated_at=NOW()
           WHERE execution_deposit_lifecycle.watcher_key=EXCLUDED.watcher_key
             AND execution_deposit_lifecycle.account_id=EXCLUDED.account_id
             AND execution_deposit_lifecycle.asset_address=EXCLUDED.asset_address
             AND execution_deposit_lifecycle.amount_base_units=EXCLUDED.amount_base_units
             AND execution_deposit_lifecycle.vault_address=EXCLUDED.vault_address
           RETURNING (xmax=0) AS inserted,status,credited_event_key,block_hash`,
          [input.watcherKey,event.transactionHash.toLowerCase(),event.logIndex,event.accountId,event.assetAddress,event.senderAddress,event.vaultAddress,
           amount.toString(),blockNumber.toString(),event.blockHash.toLowerCase(),status,event.confirmations,event.requiredConfirmations],
        );
        const row = upsert.rows[0] as {inserted:boolean;status:string;credited_event_key:string|null;block_hash:string}|undefined;
        if (!row) throw new Error("Deposit event conflicts with previously recorded immutable event data.");
        if (row.inserted) inserted++;
        if (row.status === "reconciliation_required") throw new Error("Deposit event block hash changed; checkpoint must not advance.");
        // Observations never authorize spendable credits. Deposits remain fail-closed until
        // allocation-aware crediting and PostgreSQL recovery verification are complete.
      }
      await c.query(
        `UPDATE execution_chain_watcher_state SET next_block=$3,last_scanned_block_hash=$4,updated_at=NOW()
         WHERE chain_id=$1 AND watcher_key=$2`,
        [input.chainId,input.watcherKey,input.nextBlock.toString(),input.lastScannedBlockHash.toLowerCase()],
      );
      await c.query("COMMIT");
      return {inserted,credited,reversed:0};
    } catch (error) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
  }
  async listActiveDeposits(input: {
    chainId: 137;
    watcherKey: string;
    fromBlock: bigint;
  }): Promise<DepositLifecycleRecord[]> {
    const result = await this.pool.query(
      `SELECT transaction_hash,log_index,account_id,asset_address,sender_address,vault_address,
              amount_base_units::text,block_number::text,block_hash,confirmations,required_confirmations,status
       FROM execution_deposit_lifecycle
       WHERE chain_id=$1 AND watcher_key=$2 AND block_number >= $3
         AND status IN ('detected','provisional','confirmed','reconciliation_required')
       ORDER BY block_number,log_index`,
      [input.chainId,input.watcherKey,input.fromBlock.toString()],
    );
    return result.rows.map((row) => ({
      chainId: 137,
      transactionHash: String(row.transaction_hash) as `0x${string}`,
      logIndex: Number(row.log_index),
      accountId: String(row.account_id),
      assetAddress: String(row.asset_address) as Address,
      senderAddress: String(row.sender_address) as Address,
      vaultAddress: String(row.vault_address) as Address,
      amountBaseUnits: String(row.amount_base_units),
      blockNumber: String(row.block_number),
      blockHash: String(row.block_hash) as `0x${string}`,
      confirmations: Number(row.confirmations),
      requiredConfirmations: Number(row.required_confirmations),
      status: String(row.status) as DepositLifecycleRecord["status"],
    }));
  }

  async recoverReorg(input: {
    chainId: 137;
    watcherKey: string;
    expectedNextBlock: bigint;
    nextBlock: bigint;
    lastScannedBlockHash: `0x${string}` | null;
    orphaned: readonly DepositLifecycleRecord[];
    reason: string;
  }): Promise<{ reversed: number; exceptions: number }> {
    if (input.nextBlock < 0n || input.nextBlock > input.expectedNextBlock) {
      throw new Error("Invalid recovery checkpoint rewind.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const checkpoint = await client.query(
        `SELECT next_block::text FROM execution_chain_watcher_state
         WHERE chain_id=$1 AND watcher_key=$2 FOR UPDATE`,
        [input.chainId,input.watcherKey],
      );
      if (!checkpoint.rows[0] || BigInt(String(checkpoint.rows[0].next_block)) !== input.expectedNextBlock) {
        throw new Error("Deposit recovery checkpoint compare-and-swap failed.");
      }
      let reversed = 0;
      let exceptions = 0;
      for (const event of input.orphaned) {
        const result = await client.query(
          `SELECT status,credited_event_key,block_hash FROM execution_deposit_lifecycle
           WHERE chain_id=$1 AND watcher_key=$2 AND transaction_hash=$3 AND log_index=$4 FOR UPDATE`,
          [input.chainId,input.watcherKey,event.transactionHash.toLowerCase(),event.logIndex],
        );
        const row = result.rows[0] as {status:string;credited_event_key:string|null;block_hash:string}|undefined;
        if (!row || row.status === "reversed") continue;
        if (row.block_hash.toLowerCase() !== event.blockHash.toLowerCase()) {
          throw new Error("Deposit changed while reorg recovery was being prepared; transaction aborted.");
        }
        if (row.credited_event_key) {
          await client.query(
            `UPDATE execution_deposit_lifecycle SET status='reconciliation_required',updated_at=NOW()
             WHERE chain_id=$1 AND watcher_key=$2 AND transaction_hash=$3 AND log_index=$4`,
            [input.chainId,input.watcherKey,event.transactionHash.toLowerCase(),event.logIndex],
          );
          await client.query(
            "UPDATE execution_control SET emergency_stop=TRUE,mismatch_detected_at=NOW(),updated_at=NOW() WHERE id=1",
          );
          await client.query(
            "INSERT INTO execution_audit_events(event_type,details) VALUES('orphaned_deposit_requires_reconciliation',$1::jsonb)",
            [JSON.stringify({watcherKey:input.watcherKey,accountId:event.accountId,assetAddress:event.assetAddress,
              transactionHash:event.transactionHash,logIndex:event.logIndex,amountBaseUnits:event.amountBaseUnits,
              blockNumber:event.blockNumber,blockHash:event.blockHash,reason:input.reason})],
          );
          exceptions++;
        } else {
          await client.query(
            `UPDATE execution_deposit_lifecycle SET status='reversed',reversed_at=NOW(),updated_at=NOW()
             WHERE chain_id=$1 AND watcher_key=$2 AND transaction_hash=$3 AND log_index=$4`,
            [input.chainId,input.watcherKey,event.transactionHash.toLowerCase(),event.logIndex],
          );
          reversed++;
        }
      }
      const rewound = await client.query(
        `UPDATE execution_chain_watcher_state SET next_block=$4,last_scanned_block_hash=$5,updated_at=NOW()
         WHERE chain_id=$1 AND watcher_key=$2 AND next_block=$3 RETURNING next_block`,
        [input.chainId,input.watcherKey,input.expectedNextBlock.toString(),input.nextBlock.toString(),input.lastScannedBlockHash],
      );
      if (rewound.rowCount !== 1) throw new Error("Deposit recovery checkpoint compare-and-swap failed.");
      await client.query("COMMIT");
      return {reversed,exceptions};
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

}
