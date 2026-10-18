import type { Pool } from "pg";
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
      SELECT id FROM execution_transactions WHERE status='prepared' AND (lease_expires_at IS NULL OR lease_expires_at<NOW())
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
  async recordDepositEvent(input:{accountId:string;token:string;amount:string;from:string;to:string;txHash:string;logIndex:number;blockNumber:string;confirmed:boolean;confirmations:number;requiredConfirmations?:number}):Promise<{credited:boolean}>{
    assertPositiveBaseUnits(input.amount,"deposit amount");
    if(!input.confirmed||input.confirmations<(input.requiredConfirmations??3))throw new Error("Deposit is not sufficiently confirmed.");
    if(!/^0x[0-9a-fA-F]{64}$/.test(input.txHash)||!Number.isInteger(input.logIndex)||input.logIndex<0||!/^[1-9][0-9]*$/.test(input.blockNumber))throw new Error("Invalid deposit event identity.");
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const i=await c.query(`INSERT INTO execution_deposit_events(chain_id,transaction_hash,log_index,account_id,asset_address,amount_base_units,from_address,to_address,block_number,confirmed_at)
        VALUES(137,$1,$2,$3,$4,$5,$6,$7,$8,NOW()) ON CONFLICT(chain_id,transaction_hash,log_index) DO NOTHING RETURNING transaction_hash`,
        [input.txHash.toLowerCase(),input.logIndex,input.accountId,input.token,input.amount,input.from,input.to,input.blockNumber]);
      if(i.rowCount===1)await c.query(`INSERT INTO execution_ledger_entries(account_id,event_key,entry_type,asset_address,amount_base_units,chain_id,transaction_hash,details)
        VALUES($1,$2,'deposit',$3,$4,137,$5,$6::jsonb) ON CONFLICT(event_key) DO NOTHING`,
        [input.accountId,`${input.txHash.toLowerCase()}:${input.logIndex}:deposit`,input.token,input.amount,input.txHash.toLowerCase(),
          JSON.stringify({from:input.from,to:input.to,blockNumber:input.blockNumber})]);
      await c.query("COMMIT");return {credited:i.rowCount===1};
    }catch(e){await c.query("ROLLBACK").catch(()=>undefined);throw e;}finally{c.release();}
  }
  /** Serialize reserve operations so concurrent withdrawals cannot overspend the same ledger balance. */
  async reserveWithdrawal(input:{id:string;accountId:string;token:string;recipient:string;amount:string;idempotencyKey:string}):Promise<{reserved:boolean}>{
    const amount=assertPositiveBaseUnits(input.amount,"withdrawal amount");
    if(!/^0x[0-9a-fA-F]{40}$/.test(input.token)||!/^0x[0-9a-fA-F]{40}$/.test(input.recipient))throw new Error("Invalid withdrawal token or recipient address.");
    if(!input.accountId.trim()||!input.idempotencyKey.trim()||!input.id.trim())throw new Error("Withdrawal reservation identity is required.");
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const duplicate=await c.query("SELECT id FROM execution_withdrawal_reservations WHERE idempotency_key=$1 FOR UPDATE",[input.idempotencyKey]);
      if(duplicate.rowCount){await c.query("COMMIT");return {reserved:false};}
      const balance=await c.query("SELECT COALESCE(SUM(amount_base_units),0)::text AS v FROM execution_ledger_entries WHERE account_id=$1 AND asset_address=$2",[input.accountId,input.token]);
      const held=await c.query("SELECT COALESCE(SUM(amount_base_units),0)::text AS v FROM execution_withdrawal_reservations WHERE account_id=$1 AND asset_address=$2 AND status IN('reserved','submitted','unknown')",[input.accountId,input.token]);
      const available=BigInt(balance.rows[0]?.v??"0")-BigInt(held.rows[0]?.v??"0");if(amount>available)throw new Error("Withdrawal exceeds withdrawable ledger balance.");
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
}
