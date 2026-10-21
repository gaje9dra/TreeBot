import type { Pool } from "pg";
import type { Address } from "viem";
import type { DepositLifecycleRecord, DepositScannerStore } from "./deposit-scanner";
import type { TransactionStatus } from "./lifecycle";
import { assertNonNegativeBaseUnits, assertPositiveBaseUnits } from "./amounts";
import { isIssuedVerifiedDepositProof } from "./deposit-scanner";
import { isIssuedWithdrawalSettlement, type VerifiedWithdrawalSettlement } from "./withdrawal-verifier";
import { isIssuedVerifiedTradeSettlement, type VerifiedTradeSettlement } from "./trade-settlement-verifier";
import { isIssuedVerifiedAssetValuation, type VerifiedAssetValuation } from "./valuation-verifier";
import { buildWithdrawalUnknownIncident } from "./withdrawal-incidents";

export interface ExecutionIntentInput {
  id:string; idempotencyKey:string; walletAddress:string; sellToken:string; buyToken:string; sellAmount:string;
  quote:Record<string,unknown>; authorizationId:string; riskChecks:Record<string,unknown>; preparedTransaction:Record<string,unknown>;
}
export interface StoredExecutionIntent extends ExecutionIntentInput { status:TransactionStatus; txHash:string|null; nonce:number|null; }
export interface PortfolioAssetSnapshot {
  assetAddress:string; ledgerBalance:string; inventoryQuantity:string; quantityMatchesLedger:boolean;
  costBasisStatus:"complete"|"pending"|"reconciliation_required"; costBasisQuoteAsset:string|null; costBasisQuoteBaseUnits:string|null;
  marketValueQuoteBaseUnits:string|null; unrealizedPnlQuoteBaseUnits:string|null; valuationSource:string|null; valuationObservedAt:string|null;
}
export interface PortfolioSnapshot {
  accountId:string; quoteAssetAddress:string; assets:PortfolioAssetSnapshot[];
  realizedPnlBeforeGasByQuoteAsset:Array<{quoteAssetAddress:string;realizedPnlBaseUnits:string}>;
  pendingTradeAccountingCount:number; valuationComplete:boolean;
  totalMarketValueQuoteBaseUnits:string|null; totalUnrealizedPnlQuoteBaseUnits:string|null;
}
function toRecord(row:Record<string,unknown>):StoredExecutionIntent{
  return {id:String(row.id),idempotencyKey:String(row.idempotency_key),walletAddress:String(row.wallet_address),
    sellToken:String(row.sell_token),buyToken:String(row.buy_token),sellAmount:String(row.sell_amount),
    quote:row.quote as Record<string,unknown>,authorizationId:String(row.authorization_id),riskChecks:row.risk_checks as Record<string,unknown>,
    preparedTransaction:row.prepared_transaction as Record<string,unknown>,status:row.status as TransactionStatus,
    txHash:row.tx_hash?String(row.tx_hash):null,nonce:row.nonce===null||row.nonce===undefined?null:Number(row.nonce)};
}
export class PostgresExecutionStore {
  private readonly accountingQuoteToken:string|null;
  private readonly trustedValuationSources:Set<string>;
  constructor(private readonly pool:Pool,accountingQuoteToken=process.env.TREEBOT_ACCOUNTING_QUOTE_TOKEN??"",
    trustedValuationSourcesJson=process.env.TREEBOT_TRUSTED_VALUATION_SOURCES_JSON??"[]"){
    this.accountingQuoteToken=/^0x[0-9a-fA-F]{40}$/.test(accountingQuoteToken)?accountingQuoteToken.toLowerCase():null;
    try{
      const sources:unknown=JSON.parse(trustedValuationSourcesJson);
      this.trustedValuationSources=new Set(Array.isArray(sources)?sources.filter((value):value is string=>typeof value==="string"&&value.trim().length>0).map((value)=>value.trim()):[]);
    }catch{this.trustedValuationSources=new Set();}
  }
  async createOrGetIntent(input:ExecutionIntentInput):Promise<{record:StoredExecutionIntent;created:boolean}>{
    if(!input.id.trim()||!input.idempotencyKey.trim())throw new Error("Intent ID and idempotency key are required.");
    if(!/^0x[0-9a-fA-F]{40}$/.test(input.walletAddress)||!/^0x[0-9a-fA-F]{40}$/.test(input.sellToken)||!/^0x[0-9a-fA-F]{40}$/.test(input.buyToken))throw new Error("Intent wallet and token addresses must be valid.");
    if(input.sellToken.toLowerCase()===input.buyToken.toLowerCase())throw new Error("Sell and buy token must differ.");
    const sellAmount=assertPositiveBaseUnits(input.sellAmount,"sell amount");
    const target=String(input.preparedTransaction.to??"");
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      // Trade and withdrawal reservations for the same wallet/asset share this lock.
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",[input.walletAddress.toLowerCase(),input.sellToken.toLowerCase()]);
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",["treebot-account-restriction",input.walletAddress.toLowerCase()]);
      const restriction=await c.query(
        "SELECT 1 FROM execution_account_restrictions WHERE account_id IN ($1,LOWER($1)) AND status='active' LIMIT 1",
        [input.walletAddress],
      );
      if(restriction.rowCount)throw new Error("Execution blocked because this account has an active financial-integrity restriction.");
      if(!/^0x[0-9a-fA-F]{40}$/.test(target))throw new Error("Prepared transaction target must be an explicit address.");
      if(!this.accountingQuoteToken)throw new Error("Trade preparation is disabled until a canonical accounting quote token is configured.");
      const sellIsQuote=input.sellToken.toLowerCase()===this.accountingQuoteToken;
      const buyIsQuote=input.buyToken.toLowerCase()===this.accountingQuoteToken;
      if(!sellIsQuote&&!buyIsQuote)throw new Error("Cross-asset trade is blocked until trusted valuation conversion is implemented for the configured accounting quote token.");

      const sameIntent=async()=>c.query(
        `SELECT 1 FROM execution_transactions WHERE id=$1 AND idempotency_key=$2
          AND LOWER(wallet_address)=LOWER($3) AND LOWER(sell_token)=LOWER($4) AND LOWER(buy_token)=LOWER($5)
          AND sell_amount=$6 AND quote=$7::jsonb AND authorization_id=$8 AND risk_checks=$9::jsonb
          AND prepared_transaction=$10::jsonb`,
        [input.id,input.idempotencyKey,input.walletAddress,input.sellToken,input.buyToken,sellAmount.toString(),
          JSON.stringify(input.quote),input.authorizationId,JSON.stringify(input.riskChecks),JSON.stringify(input.preparedTransaction)],
      );
      const duplicate=await c.query("SELECT * FROM execution_transactions WHERE idempotency_key=$1 FOR UPDATE",[input.idempotencyKey]);
      if(duplicate.rowCount){
        if(!(await sameIntent()).rowCount)throw new Error("Execution idempotency key was reused with different immutable transaction parameters.");
        const record=toRecord(duplicate.rows[0] as Record<string,unknown>);
        await c.query("INSERT INTO execution_audit_events(transaction_id,event_type,details) VALUES($1,'idempotent_replay',$2::jsonb)",
          [record.id,JSON.stringify({idempotencyKey:input.idempotencyKey})]);
        await c.query("COMMIT");return {record,created:false};
      }
      const idCollision=await c.query("SELECT 1 FROM execution_transactions WHERE id=$1",[input.id]);
      if(idCollision.rowCount)throw new Error("Execution intent ID already belongs to another reservation.");

      const authorization=await c.query(
        "SELECT owner_address,chain_id,allowed_tokens,allowed_targets,maximum_sell_amount::text AS maximum_sell_amount,expires_at,revoked_at FROM execution_authorizations WHERE id=$1 FOR SHARE",
        [input.authorizationId],
      );
      const auth=authorization.rows[0];
      if(!auth||Number(auth.chain_id)!==137||String(auth.owner_address).toLowerCase()!==input.walletAddress.toLowerCase()||
        auth.revoked_at||new Date(auth.expires_at).getTime()<=Date.now()||BigInt(String(auth.maximum_sell_amount))<sellAmount){
        throw new Error("Execution authorization is missing, expired, revoked, owner-mismatched, or below the requested amount.");
      }
      const allowedTokens=Array.isArray(auth.allowed_tokens)?auth.allowed_tokens as string[]:[];
      const allowedTargets=Array.isArray(auth.allowed_targets)?auth.allowed_targets as string[]:[];
      if(!allowedTokens.some((value)=>value.toLowerCase()===input.sellToken.toLowerCase())||
        !allowedTokens.some((value)=>value.toLowerCase()===input.buyToken.toLowerCase())||
        !allowedTargets.some((value)=>value.toLowerCase()===target.toLowerCase())){
        throw new Error("Execution authorization does not allow this sell token or transaction target.");
      }

      const ledger=await c.query(
        "SELECT COALESCE(SUM(amount_base_units),0)::text AS amount FROM execution_ledger_entries WHERE LOWER(account_id)=LOWER($1) AND LOWER(asset_address)=LOWER($2) AND entry_type <> 'realized_pnl'",
        [input.walletAddress,input.sellToken],
      );
      const inventory=await c.query("SELECT COALESCE(quantity_base_units,0)::text AS amount FROM execution_position_inventory WHERE chain_id=137 AND LOWER(account_id)=LOWER($1) AND LOWER(asset_address)=LOWER($2)",[input.walletAddress,input.sellToken]);
      const ledgerAmount=BigInt(ledger.rows[0]?.amount??"0");
      const inventoryAmount=BigInt(inventory.rows[0]?.amount??"0");
      if(ledgerAmount!==inventoryAmount)throw new Error("Trade reservation blocked by a ledger/inventory mismatch requiring reconciliation.");
      if(!sellIsQuote){
        const basis=await c.query(
          "SELECT quantity_base_units::text AS quantity,cost_basis_status FROM execution_open_positions WHERE LOWER(account_id)=LOWER($1) AND LOWER(asset_address)=LOWER($2) AND LOWER(quote_asset_address)=LOWER($3) FOR SHARE",
          [input.walletAddress,input.sellToken,this.accountingQuoteToken],
        );
        if(!basis.rows[0]||basis.rows[0].cost_basis_status!=="complete"||BigInt(String(basis.rows[0].quantity))!==inventoryAmount||sellAmount>inventoryAmount){
          throw new Error("Trade sale blocked because complete quote-token cost basis does not cover the full inventory quantity.");
        }
      }
      const heldWithdrawals=await c.query(
        `SELECT COALESCE(SUM(amount_base_units),0)::text AS amount FROM execution_withdrawal_reservations
         WHERE (LOWER(account_id)=LOWER($1) OR LOWER(source_address)=LOWER($1))
           AND LOWER(asset_address)=LOWER($2) AND status IN('reserved','submitting','submitted','unknown')`,
        [input.walletAddress,input.sellToken],
      );
      const heldTrades=await c.query(
        `SELECT COALESCE(SUM(sell_amount),0)::text AS amount FROM execution_transactions
         WHERE LOWER(wallet_address)=LOWER($1) AND LOWER(sell_token)=LOWER($2)
           AND status IN('prepared','awaiting_signature','signed','submitted','pending','unknown','replaced')`,
        [input.walletAddress,input.sellToken],
      );
      const available=ledgerAmount-BigInt(heldWithdrawals.rows[0]?.amount??"0")-BigInt(heldTrades.rows[0]?.amount??"0");
      if(available<0n||sellAmount>available)throw new Error("Execution exceeds available ledger balance after active trade and withdrawal reservations.");

      const inserted=await c.query(`INSERT INTO execution_transactions
        (id,idempotency_key,chain_id,wallet_address,sell_token,buy_token,side,sell_amount,quote,authorization_id,risk_checks,prepared_transaction,status)
        VALUES($1,$2,137,$3,LOWER($4),LOWER($5),'sell',$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,'prepared')
        ON CONFLICT(idempotency_key) DO NOTHING RETURNING *`,
        [input.id,input.idempotencyKey,input.walletAddress,input.sellToken,input.buyToken,sellAmount.toString(),
          JSON.stringify(input.quote),input.authorizationId,JSON.stringify(input.riskChecks),JSON.stringify(input.preparedTransaction)]);
      if(inserted.rowCount!==1){
        if(!(await sameIntent()).rowCount)throw new Error("Execution idempotency key was concurrently claimed by different immutable transaction parameters.");
        const replay=await c.query("SELECT * FROM execution_transactions WHERE idempotency_key=$1 FOR UPDATE",[input.idempotencyKey]);
        const record=toRecord(replay.rows[0] as Record<string,unknown>);
        await c.query("INSERT INTO execution_audit_events(transaction_id,event_type,details) VALUES($1,'idempotent_replay',$2::jsonb)",
          [record.id,JSON.stringify({idempotencyKey:input.idempotencyKey})]);
        await c.query("COMMIT");return {record,created:false};
      }
      const record=toRecord(inserted.rows[0] as Record<string,unknown>);
      await c.query("INSERT INTO execution_audit_events(transaction_id,event_type,details) VALUES($1,'intent_reserved',$2::jsonb)",
        [record.id,JSON.stringify({idempotencyKey:input.idempotencyKey,sellAmount:sellAmount.toString(),availableBeforeReservation:available.toString()})]);
      await c.query("COMMIT");return {record,created:true};
    }catch(e){await c.query("ROLLBACK").catch(()=>undefined);throw e;}finally{c.release();}
  }
  async leasePreparedIntent(workerId:string,leaseMs=30_000):Promise<StoredExecutionIntent|null>{
    if(!workerId.trim()||!Number.isInteger(leaseMs)||leaseMs<1000||leaseMs>300_000)throw new Error("Invalid worker lease.");
    const r=await this.pool.query(`WITH candidate AS (
      SELECT id FROM execution_transactions
      WHERE status='prepared' AND (lease_expires_at IS NULL OR lease_expires_at<NOW())
        AND $2::text IS NOT NULL
        AND (LOWER(execution_transactions.sell_token)=LOWER($2) OR LOWER(execution_transactions.buy_token)=LOWER($2))
        AND (LOWER(execution_transactions.sell_token)=LOWER($2) OR EXISTS (
          SELECT 1 FROM execution_open_positions p
          JOIN execution_position_inventory i ON i.chain_id=137 AND LOWER(i.account_id)=LOWER(p.account_id) AND LOWER(i.asset_address)=LOWER(p.asset_address)
          WHERE LOWER(p.account_id)=LOWER(execution_transactions.wallet_address)
            AND LOWER(p.asset_address)=LOWER(execution_transactions.sell_token)
            AND LOWER(p.quote_asset_address)=LOWER($2) AND p.cost_basis_status='complete'
            AND p.quantity_base_units=i.quantity_base_units AND p.quantity_base_units>=execution_transactions.sell_amount
        ))
        AND EXISTS (SELECT 1 FROM execution_control WHERE id=1 AND emergency_stop=FALSE)
        AND NOT EXISTS (
          SELECT 1 FROM execution_account_restrictions r
          WHERE r.status='active'
            AND r.account_id IN (execution_transactions.wallet_address,LOWER(execution_transactions.wallet_address))
        )
        AND EXISTS (
          SELECT 1 FROM execution_authorizations a
          WHERE a.id=execution_transactions.authorization_id AND a.chain_id=137
            AND LOWER(a.owner_address)=LOWER(execution_transactions.wallet_address)
            AND a.revoked_at IS NULL AND a.expires_at>NOW()
            AND a.maximum_sell_amount>=execution_transactions.sell_amount
            AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(a.allowed_tokens) AS allowed(token) WHERE LOWER(allowed.token)=LOWER(execution_transactions.sell_token))
            AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(a.allowed_tokens) AS allowed(token) WHERE LOWER(allowed.token)=LOWER(execution_transactions.buy_token))
            AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(a.allowed_targets) AS allowed(target) WHERE LOWER(allowed.target)=LOWER(execution_transactions.prepared_transaction->>'to'))
        )
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE execution_transactions t SET lease_owner=$1,lease_expires_at=NOW()+($3::text||' milliseconds')::interval,updated_at=NOW()
      FROM candidate c WHERE t.id=c.id RETURNING t.*`,[workerId,this.accountingQuoteToken,leaseMs]);
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
  async getExecutionIntentForSettlement(id:string):Promise<StoredExecutionIntent>{
    const result=await this.pool.query("SELECT * FROM execution_transactions WHERE id=$1",[id]);
    if(!result.rows[0])throw new Error("Execution intent not found for settlement.");
    return toRecord(result.rows[0] as Record<string,unknown>);
  }

  /** Legacy caller-supplied settlement is intentionally disabled. */
  async recordSettlement(_input:{id:string;status:"confirmed"|"reverted";blockNumber:string;actualSellAmount:string;actualBuyAmount:string;gasWei:string;realizedPnlBaseUnits?:string;quoteFeeBaseUnits?:string}):Promise<void>{
    throw new Error("Unverified trade settlement is disabled; use the proof-bearing recordVerifiedSettlement path.");
  }

  async recordVerifiedSettlement(proof:VerifiedTradeSettlement):Promise<{settled:boolean;status:"confirmed"|"reverted"}>{
    if(!isIssuedVerifiedTradeSettlement(proof))throw new Error("Trade settlement proof was not issued by the trusted Polygon verifier.");
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const initial=await c.query("SELECT wallet_address,sell_token,buy_token FROM execution_transactions WHERE id=$1",[proof.executionId]);
      const initialRow=initial.rows[0];
      if(!initialRow)throw new Error("Execution intent not found for settlement.");
      const assets=[String(initialRow.sell_token).toLowerCase(),String(initialRow.buy_token).toLowerCase()].sort();
      for(const asset of assets)await c.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",[String(initialRow.wallet_address).toLowerCase(),asset]);
      const result=await c.query("SELECT * FROM execution_transactions WHERE id=$1 FOR UPDATE",[proof.executionId]);
      const row=result.rows[0] as Record<string,unknown>|undefined;
      if(!row)throw new Error("Execution intent disappeared during settlement.");
      const txHash=String(row.tx_hash??"").toLowerCase();
      const status=String(row.status);
      if(status==="confirmed"||status==="reverted"){
        const same=status===proof.status&&txHash===proof.transactionHash.toLowerCase()&&Number(row.nonce)===proof.nonce&&
          String(row.confirmation_block)===proof.blockNumber&&String(row.confirmation_block_hash??"").toLowerCase()===proof.blockHash.toLowerCase()&&
          String(row.actual_sell_amount??"0")===proof.actualSellAmountBaseUnits&&String(row.actual_buy_amount??"0")===proof.actualBuyAmountBaseUnits&&
          String(row.actual_gas_wei??"0")===proof.gasWei&&String(row.settlement_status??"")===proof.status;
        if(!same)throw new Error("Conflicting verified settlement evidence already exists for this execution.");
        await c.query("COMMIT");return {settled:false,status:proof.status};
      }
      if(!["submitted","pending","unknown","replaced"].includes(status))throw new Error("Execution intent is not eligible for verified settlement.");
      const prepared=(row.prepared_transaction??{}) as Record<string,unknown>;
      const preparedValue=prepared.value===undefined?"0":String(prepared.value);
      if(txHash!==proof.transactionHash.toLowerCase()||Number(row.nonce)!==proof.nonce||
        String(row.wallet_address).toLowerCase()!==proof.walletAddress.toLowerCase()||
        String(row.sell_token).toLowerCase()!==proof.sellToken.toLowerCase()||
        String(row.buy_token).toLowerCase()!==proof.buyToken.toLowerCase()||
        String(row.sell_amount)!==proof.reservedSellAmountBaseUnits||
        String(prepared.to??"").toLowerCase()!==proof.transactionTarget.toLowerCase()||
        String(prepared.data??"").toLowerCase()!==proof.transactionData.toLowerCase()||
        BigInt(preparedValue)!==BigInt(proof.transactionValueWei)){
        throw new Error("Verified settlement proof does not match the immutable execution intent.");
      }
      if(proof.confirmations<proof.requiredConfirmations)throw new Error("Verified settlement proof does not meet the required finality policy.");
      const evidence=JSON.stringify({
        chainId:proof.chainId,transactionHash:proof.transactionHash,nonce:proof.nonce,status:proof.status,
        walletAddress:proof.walletAddress,sellToken:proof.sellToken,buyToken:proof.buyToken,
        transactionTarget:proof.transactionTarget,transactionData:proof.transactionData,transactionValueWei:proof.transactionValueWei,
        reservedSellAmountBaseUnits:proof.reservedSellAmountBaseUnits,actualSellAmountBaseUnits:proof.actualSellAmountBaseUnits,
        actualBuyAmountBaseUnits:proof.actualBuyAmountBaseUnits,gasWei:proof.gasWei,blockNumber:proof.blockNumber,
        blockHash:proof.blockHash,confirmations:proof.confirmations,requiredConfirmations:proof.requiredConfirmations,
        sellTransferLogIndexes:proof.sellTransferLogIndexes,buyTransferLogIndexes:proof.buyTransferLogIndexes,
        gasUsed:proof.gasUsed,effectiveGasPriceWei:proof.effectiveGasPriceWei,
      });
      const updated=await c.query(
        `UPDATE execution_transactions SET status=$2,confirmation_block=$3,confirmation_block_hash=$4,
          actual_sell_amount=$5,actual_buy_amount=$6,actual_gas_wei=$7,
          execution_price=CASE WHEN $5::numeric>0 THEN $6::numeric/$5::numeric ELSE NULL END,
          settlement_status=$2,settlement_evidence=$8::jsonb,settlement_verified_at=NOW(),
          confirmed_at=CASE WHEN $2='confirmed' THEN NOW() ELSE confirmed_at END,updated_at=NOW()
         WHERE id=$1 AND status IN('submitted','pending','unknown','replaced') RETURNING id`,
        [proof.executionId,proof.status,proof.blockNumber,proof.blockHash,proof.actualSellAmountBaseUnits,proof.actualBuyAmountBaseUnits,proof.gasWei,evidence],
      );
      if(updated.rowCount!==1)throw new Error("Execution intent changed while verified settlement was being recorded.");
      await c.query("INSERT INTO execution_audit_events(transaction_id,event_type,details) VALUES($1,'trade_settlement_verified',$2::jsonb)",
        [proof.executionId,evidence]);

      const accountId=String(row.wallet_address);
      const quoteToken=this.accountingQuoteToken;
      let accountingStatus:"pending"|"complete"|"reconciliation_required"|"not_applicable"=proof.status==="reverted"?"not_applicable":"pending";
      let costBasisAllocated:string|null=null;
      let realizedPnl:string|null=null;
      let costBasisFailure:string|null=null;
      let priorSellQty=0n,priorBuyQty=0n,priorSellCost=0n,priorBuyCost=0n,priorSellBasisQty=0n;
      let sellBasisComplete=false,buyBasisComplete=false;
      if(proof.status==="confirmed"){
        const priorSellInventoryQ=await c.query("SELECT quantity_base_units::text AS quantity FROM execution_position_inventory WHERE chain_id=137 AND account_id=$1 AND LOWER(asset_address)=LOWER($2) FOR UPDATE",[accountId,proof.sellToken]);
        const priorBuyInventoryQ=await c.query("SELECT quantity_base_units::text AS quantity FROM execution_position_inventory WHERE chain_id=137 AND account_id=$1 AND LOWER(asset_address)=LOWER($2) FOR UPDATE",[accountId,proof.buyToken]);
        priorSellQty=BigInt(priorSellInventoryQ.rows[0]?.quantity??"0");
        priorBuyQty=BigInt(priorBuyInventoryQ.rows[0]?.quantity??"0");
        if(quoteToken&&proof.sellToken.toLowerCase()===quoteToken){
          const basis=await c.query("SELECT quantity_base_units::text AS quantity,cost_basis_quote_base_units::text AS cost_basis,cost_basis_status FROM execution_open_positions WHERE LOWER(account_id)=LOWER($1) AND LOWER(asset_address)=LOWER($2) AND LOWER(quote_asset_address)=LOWER($3) FOR UPDATE",[accountId,proof.buyToken,quoteToken]);
          buyBasisComplete=(!basis.rows[0]&&priorBuyQty===0n)||(!!basis.rows[0]&&basis.rows[0].cost_basis_status==="complete"&&BigInt(String(basis.rows[0].quantity))===priorBuyQty);
          priorBuyCost=buyBasisComplete&&basis.rows[0]?BigInt(String(basis.rows[0].cost_basis)):0n;
        }else if(quoteToken&&proof.buyToken.toLowerCase()===quoteToken){
          const basis=await c.query("SELECT quantity_base_units::text AS quantity,cost_basis_quote_base_units::text AS cost_basis,cost_basis_status FROM execution_open_positions WHERE LOWER(account_id)=LOWER($1) AND LOWER(asset_address)=LOWER($2) AND LOWER(quote_asset_address)=LOWER($3) FOR UPDATE",[accountId,proof.sellToken,quoteToken]);
          sellBasisComplete=!!basis.rows[0]&&basis.rows[0].cost_basis_status==="complete"&&BigInt(String(basis.rows[0].quantity))===priorSellQty&&priorSellQty>=BigInt(proof.actualSellAmountBaseUnits);
          priorSellBasisQty=BigInt(String(basis.rows[0]?.quantity??"0"));
          priorSellCost=sellBasisComplete?BigInt(String(basis.rows[0].cost_basis)):0n;
        }else{
          accountingStatus="reconciliation_required";
          costBasisFailure=quoteToken?"Cross-asset settlement lacks a canonical quote-token side.":"Canonical accounting quote token is not configured.";
        }
        const sellInventory=await c.query(
          `UPDATE execution_position_inventory SET quantity_base_units=quantity_base_units-$3::numeric,updated_at=NOW()
           WHERE chain_id=137 AND account_id=$1 AND LOWER(asset_address)=LOWER($2) AND quantity_base_units >= $3::numeric
           RETURNING quantity_base_units::text AS quantity`,
          [accountId,proof.sellToken,proof.actualSellAmountBaseUnits],
        );
        await c.query(
          `INSERT INTO execution_position_inventory(chain_id,account_id,asset_address,quantity_base_units,updated_at)
           VALUES(137,$1,LOWER($2),$3::numeric,NOW())
           ON CONFLICT(chain_id,account_id,asset_address) DO UPDATE SET quantity_base_units=execution_position_inventory.quantity_base_units+EXCLUDED.quantity_base_units,updated_at=NOW()`,
          [accountId,proof.buyToken,proof.actualBuyAmountBaseUnits],
        );
        await c.query(`INSERT INTO execution_ledger_entries(account_id,event_key,entry_type,asset_address,amount_base_units,chain_id,transaction_hash,details)
          VALUES($1,$2,'trade_sell',LOWER($3),-$4::numeric,137,$5,$6::jsonb)`,
          [accountId,proof.transactionHash+":sell",proof.sellToken,proof.actualSellAmountBaseUnits,proof.transactionHash,evidence]);
        await c.query(`INSERT INTO execution_ledger_entries(account_id,event_key,entry_type,asset_address,amount_base_units,chain_id,transaction_hash,details)
          VALUES($1,$2,'trade_buy',LOWER($3),$4::numeric,137,$5,$6::jsonb)`,
          [accountId,proof.transactionHash+":buy",proof.buyToken,proof.actualBuyAmountBaseUnits,proof.transactionHash,evidence]);
        if(BigInt(proof.gasWei)>0n)await c.query(`INSERT INTO execution_ledger_entries(account_id,event_key,entry_type,asset_address,amount_base_units,chain_id,transaction_hash,details)
          VALUES($1,$2,'gas','0x0000000000000000000000000000000000000000',-$3::numeric,137,$4,$5::jsonb)`,
          [accountId,proof.transactionHash+":gas",proof.gasWei,proof.transactionHash,evidence]);
        const sellQuantity=await c.query("SELECT quantity_base_units::text AS quantity FROM execution_position_inventory WHERE chain_id=137 AND account_id=$1 AND LOWER(asset_address)=LOWER($2)",[accountId,proof.sellToken]);
        const buyQuantity=await c.query("SELECT quantity_base_units::text AS quantity FROM execution_position_inventory WHERE chain_id=137 AND account_id=$1 AND LOWER(asset_address)=LOWER($2)",[accountId,proof.buyToken]);
        const syncPosition=async(asset:string,quantity:string)=>{
          await c.query(
            `INSERT INTO execution_open_positions(account_id,asset_address,quantity_base_units,cost_basis_quote_base_units,quote_asset_address,updated_at,cost_basis_status)
             VALUES($1,LOWER($2),$3::numeric,0,'0x0000000000000000000000000000000000000000',NOW(),'pending')
             ON CONFLICT(account_id,asset_address,quote_asset_address) DO UPDATE SET quantity_base_units=EXCLUDED.quantity_base_units,
               cost_basis_status=CASE WHEN execution_open_positions.cost_basis_status='complete' THEN 'reconciliation_required' ELSE 'pending' END,updated_at=NOW()`,
            [accountId,asset,quantity],
          );
        };
        await syncPosition(proof.sellToken,String(sellQuantity.rows[0]?.quantity??"0"));
        await syncPosition(proof.buyToken,String(buyQuantity.rows[0]?.quantity??"0"));

        if(quoteToken&&proof.sellToken.toLowerCase()===quoteToken){
          const newQuantity=priorBuyQty+BigInt(proof.actualBuyAmountBaseUnits);
          const newCostBasis=buyBasisComplete?priorBuyCost+BigInt(proof.actualSellAmountBaseUnits):0n;
          await c.query(
            `INSERT INTO execution_open_positions(account_id,asset_address,quantity_base_units,cost_basis_quote_base_units,quote_asset_address,updated_at,cost_basis_status)
             VALUES($1,LOWER($2),$3::numeric,$4::numeric,$5,NOW(),$6)
             ON CONFLICT(account_id,asset_address,quote_asset_address) DO UPDATE SET quantity_base_units=EXCLUDED.quantity_base_units,
               cost_basis_quote_base_units=EXCLUDED.cost_basis_quote_base_units,cost_basis_status=EXCLUDED.cost_basis_status,updated_at=NOW()`,
            [accountId,proof.buyToken,newQuantity.toString(),newCostBasis.toString(),quoteToken,buyBasisComplete?"complete":"pending"],
          );
          accountingStatus=buyBasisComplete?"complete":"pending";
        }else if(quoteToken&&proof.buyToken.toLowerCase()===quoteToken){
          if(sellBasisComplete){
            const allocated=(priorSellCost*BigInt(proof.actualSellAmountBaseUnits))/priorSellBasisQty;
            costBasisAllocated=allocated.toString();
            realizedPnl=(BigInt(proof.actualBuyAmountBaseUnits)-allocated).toString();
            const reducedQuantity=priorSellBasisQty-BigInt(proof.actualSellAmountBaseUnits);
            const reducedCost=priorSellCost-allocated;
            await c.query(
              `UPDATE execution_open_positions SET quantity_base_units=$4::numeric,cost_basis_quote_base_units=$5::numeric,cost_basis_status='complete',updated_at=NOW()
               WHERE LOWER(account_id)=LOWER($1) AND LOWER(asset_address)=LOWER($2) AND LOWER(quote_asset_address)=LOWER($3)`,
              [accountId,proof.sellToken,quoteToken,reducedQuantity.toString(),reducedCost.toString()],
            );
            await c.query(
              `INSERT INTO execution_ledger_entries(account_id,event_key,entry_type,asset_address,amount_base_units,chain_id,transaction_hash,details)
               VALUES($1,$2,'realized_pnl',LOWER($3),$4::numeric,137,$5,$6::jsonb)`,
              [accountId,proof.transactionHash+":pnl",quoteToken,realizedPnl,proof.transactionHash,evidence],
            );
            accountingStatus="complete";
          }else{
            accountingStatus="reconciliation_required";
            costBasisFailure="A sale settled without complete cost basis covering the full sell-token inventory.";
            await c.query(
              "UPDATE execution_open_positions SET cost_basis_status='reconciliation_required',updated_at=NOW() WHERE LOWER(account_id)=LOWER($1) AND LOWER(asset_address)=LOWER($2) AND LOWER(quote_asset_address)=LOWER($3)",
              [accountId,proof.sellToken,quoteToken],
            );
          }
        }else{
          accountingStatus="reconciliation_required";
          costBasisFailure=costBasisFailure??"Trade accounting cannot value this settlement in the configured quote token.";
        }

        const reconcileAsset=async(asset:string,inventoryQuantity:string)=>{
          const ledger=await c.query("SELECT COALESCE(SUM(amount_base_units),0)::text AS quantity FROM execution_ledger_entries WHERE LOWER(account_id)=LOWER($1) AND LOWER(asset_address)=LOWER($2) AND entry_type <> 'realized_pnl'",[accountId,asset]);
          const ledgerQuantity=BigInt(ledger.rows[0]?.quantity??"0"), inventory=BigInt(inventoryQuantity);
          const discrepancy=ledgerQuantity-inventory;
          await c.query(
            "INSERT INTO execution_portfolio_reconciliation(chain_id,account_id,asset_address,ledger_balance,inventory_quantity,discrepancy,status) VALUES(137,$1,LOWER($2),$3::numeric,$4::numeric,$5::numeric,$6)",
            [accountId,asset,ledgerQuantity.toString(),inventory.toString(),discrepancy.toString(),discrepancy===0n?"matched":"mismatch"],
          );
          if(discrepancy!==0n||!sellInventory.rowCount&&asset.toLowerCase()===proof.sellToken.toLowerCase()){
            const incidentKey="trade-ledger-mismatch:137:"+proof.transactionHash.toLowerCase()+":"+asset.toLowerCase();
            const amount=(discrepancy<0n?-discrepancy:discrepancy).toString();
            const details=JSON.stringify({executionId:proof.executionId,transactionHash:proof.transactionHash,assetAddress:asset,ledgerBalance:ledgerQuantity.toString(),inventoryQuantity:inventory.toString(),discrepancy:discrepancy.toString(),sellInventoryDebitApplied:!!sellInventory.rowCount});
            await c.query(
              `INSERT INTO execution_financial_incidents(incident_key,incident_type,account_id,asset_address,amount_base_units,chain_id,transaction_hash,log_index,status,details)
               VALUES($1,'ledger_mismatch',$2,LOWER($3),$4::numeric,137,$5,NULL,'open',$6::jsonb) ON CONFLICT(incident_key) DO NOTHING`,
              [incidentKey,accountId,asset,amount,proof.transactionHash,details],
            );
            await c.query(
              `INSERT INTO execution_account_restrictions(account_id,restriction_key,restriction_type,status,reason,evidence)
               VALUES($1,$2,'ledger_mismatch','active','Trade settlement exposed a ledger/inventory mismatch.',$3::jsonb) ON CONFLICT(restriction_key) DO NOTHING`,
              [accountId,incidentKey,details],
            );
            await c.query("UPDATE execution_control SET emergency_stop=TRUE WHERE id=1");
          }
        };
        await reconcileAsset(proof.sellToken,String(sellQuantity.rows[0]?.quantity??"0"));
        await reconcileAsset(proof.buyToken,String(buyQuantity.rows[0]?.quantity??"0"));
        if(costBasisFailure){
          const incidentKey="trade-cost-basis:137:"+proof.transactionHash.toLowerCase();
          const details=JSON.stringify({executionId:proof.executionId,transactionHash:proof.transactionHash,quoteToken,cause:costBasisFailure,
            sellToken:proof.sellToken,buyToken:proof.buyToken,sellAmount:proof.actualSellAmountBaseUnits,buyAmount:proof.actualBuyAmountBaseUnits});
          await c.query(
            `INSERT INTO execution_financial_incidents(incident_key,incident_type,account_id,asset_address,amount_base_units,chain_id,transaction_hash,log_index,status,details)
             VALUES($1,'settlement_conflict',$2,LOWER($3),$4::numeric,137,$5,NULL,'open',$6::jsonb) ON CONFLICT(incident_key) DO NOTHING`,
            [incidentKey,accountId,proof.sellToken,proof.actualSellAmountBaseUnits,proof.transactionHash,details],
          );
          await c.query(
            `INSERT INTO execution_account_restrictions(account_id,restriction_key,restriction_type,status,reason,evidence)
             VALUES($1,$2,'operator_hold','active','Trade cost basis requires reconciliation.',$3::jsonb) ON CONFLICT(restriction_key) DO NOTHING`,
            [accountId,incidentKey,details],
          );
          await c.query("UPDATE execution_control SET emergency_stop=TRUE WHERE id=1");
        }
      }else if(BigInt(proof.gasWei)>0n){
        await c.query(`INSERT INTO execution_ledger_entries(account_id,event_key,entry_type,asset_address,amount_base_units,chain_id,transaction_hash,details)
          VALUES($1,$2,'gas','0x0000000000000000000000000000000000000000',-$3::numeric,137,$4,$5::jsonb)`,
          [accountId,proof.transactionHash+":gas",proof.gasWei,proof.transactionHash,evidence]);
      }
      await c.query(
        `INSERT INTO execution_trade_accounting(execution_id,chain_id,account_id,sell_asset,buy_asset,sell_amount_base_units,buy_amount_base_units,gas_wei,
          quote_asset_address,cost_basis_allocated_quote_base_units,realized_pnl_quote_base_units,accounting_status,details)
         VALUES($1,137,$2,LOWER($3),LOWER($4),$5::numeric,$6::numeric,$7::numeric,$8,$9::numeric,$10::numeric,$11,$12::jsonb)`,
        [proof.executionId,accountId,proof.sellToken,proof.buyToken,proof.actualSellAmountBaseUnits,proof.actualBuyAmountBaseUnits,proof.gasWei,
          quoteToken,costBasisAllocated,realizedPnl,accountingStatus,JSON.stringify({proofStatus:proof.status,costBasisFailure})],
      );
      await c.query("COMMIT");
      return {settled:true,status:proof.status};
    }catch(error){await c.query("ROLLBACK").catch(()=>undefined);throw error;}finally{c.release();}
  }

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
  async reserveWithdrawal(input:{id:string;accountId:string;sourceAddress:string;token:string;recipient:string;amount:string;idempotencyKey:string}):Promise<{reserved:boolean}>{
    const amount=assertPositiveBaseUnits(input.amount,"withdrawal amount");
    if(!/^0x[0-9a-fA-F]{40}$/.test(input.sourceAddress)||!/^0x[0-9a-fA-F]{40}$/.test(input.token)||!/^0x[0-9a-fA-F]{40}$/.test(input.recipient))throw new Error("Invalid withdrawal source, token, or recipient address.");
    if(!input.accountId.trim()||!input.idempotencyKey.trim()||!input.id.trim())throw new Error("Withdrawal reservation identity is required.");
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      // READ COMMITTED plus sorted account+wallet asset locks serializes trade and withdrawal reservations.
      const balanceLockKeys=[...new Set([input.accountId.toLowerCase(),input.sourceAddress.toLowerCase()])].sort();
      for(const key of balanceLockKeys)await c.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",[key,input.token.toLowerCase()]);
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", ["treebot-account-restriction", input.accountId.toLowerCase()]);
      const duplicate=await c.query(
        "SELECT id,account_id,source_address,asset_address,recipient_address,amount_base_units::text FROM execution_withdrawal_reservations WHERE idempotency_key=$1 FOR UPDATE",
        [input.idempotencyKey],
      );
      if(duplicate.rowCount){
        const row=duplicate.rows[0];
        const same=row.id===input.id&&row.account_id===input.accountId&&String(row.source_address??"").toLowerCase()===input.sourceAddress.toLowerCase()&&
          String(row.asset_address).toLowerCase()===input.token.toLowerCase()&&String(row.recipient_address).toLowerCase()===input.recipient.toLowerCase()&&
          String(row.amount_base_units)===amount.toString();
        if(!same)throw new Error("Withdrawal idempotency key was reused with different immutable parameters.");
        await c.query("COMMIT");return {reserved:false};
      }
      const existing=await c.query("SELECT id FROM execution_withdrawal_reservations WHERE id=$1 OR idempotency_key=$2",[input.id,input.idempotencyKey]);
      if(existing.rowCount)throw new Error("Withdrawal ID or idempotency key already belongs to another reservation.");
      const control=await c.query("SELECT emergency_stop FROM execution_control WHERE id=1 FOR UPDATE");
      if(!control.rows[0]||control.rows[0].emergency_stop!==false)throw new Error("Withdrawal blocked by execution emergency stop.");
      const restriction=await c.query(
        "SELECT 1 FROM execution_account_restrictions WHERE account_id IN ($1,LOWER($1),LOWER($2)) AND status='active' LIMIT 1",
        [input.accountId,input.sourceAddress],
      );
      if(restriction.rowCount)throw new Error("Withdrawal blocked by an active account financial-integrity restriction.");
      const recon=await c.query("SELECT status FROM execution_reconciliation WHERE LOWER(wallet_address)=LOWER($1) AND LOWER(token_address)=LOWER($2) ORDER BY reconciled_at DESC LIMIT 1",[input.sourceAddress,input.token]);
      if(recon.rows[0]?.status!=="matched")throw new Error("Withdrawal blocked until chain-to-ledger reconciliation is matched.");
      const balance=await c.query("SELECT COALESCE(SUM(amount_base_units),0)::text AS v FROM execution_ledger_entries WHERE account_id=$1 AND LOWER(asset_address)=LOWER($2) AND entry_type <> 'realized_pnl'",[input.accountId,input.token]);
      const inventory=await c.query("SELECT COALESCE(quantity_base_units,0)::text AS v FROM execution_position_inventory WHERE chain_id=137 AND account_id=$1 AND LOWER(asset_address)=LOWER($2)",[input.accountId,input.token]);
      const ledgerAmount=BigInt(balance.rows[0]?.v??"0");
      const inventoryAmount=BigInt(inventory.rows[0]?.v??"0");
      if(ledgerAmount!==inventoryAmount)throw new Error("Withdrawal reservation blocked by a ledger/inventory mismatch requiring reconciliation.");
      const held=await c.query("SELECT COALESCE(SUM(amount_base_units),0)::text AS v FROM execution_withdrawal_reservations WHERE (account_id=$1 OR LOWER(source_address)=LOWER($3)) AND LOWER(asset_address)=LOWER($2) AND status IN('reserved','submitting','submitted','unknown')",[input.accountId,input.token,input.sourceAddress]);
      const heldTrades=await c.query("SELECT COALESCE(SUM(sell_amount),0)::text AS v FROM execution_transactions WHERE LOWER(wallet_address)=LOWER($1) AND LOWER(sell_token)=LOWER($2) AND status IN('prepared','awaiting_signature','signed','submitted','pending','unknown','replaced')",[input.sourceAddress,input.token]);
      const available=ledgerAmount-BigInt(held.rows[0]?.v??"0")-BigInt(heldTrades.rows[0]?.v??"0");if(available<0n||amount>available)throw new Error("Withdrawal exceeds available ledger balance after active trade and withdrawal reservations.");
      await c.query(`INSERT INTO execution_withdrawal_reservations(id,account_id,source_address,asset_address,recipient_address,amount_base_units,status,idempotency_key)
        VALUES($1,$2,LOWER($3),LOWER($4),LOWER($5),$6,'reserved',$7)`,[input.id,input.accountId,input.sourceAddress,input.token,input.recipient,amount.toString(),input.idempotencyKey]);
      await c.query(
        "INSERT INTO execution_withdrawal_audit_events(withdrawal_id,from_status,to_status,event_key,details) VALUES($1,NULL,'reserved',$2,$3::jsonb)",
        [input.id,"withdrawal:"+input.id+":reserved",JSON.stringify({accountId:input.accountId,sourceAddress:input.sourceAddress.toLowerCase(),token:input.token.toLowerCase(),recipient:input.recipient.toLowerCase(),amountBaseUnits:amount.toString(),idempotencyKey:input.idempotencyKey})],
      );
      await c.query("COMMIT");return {reserved:true};
    }catch(e){await c.query("ROLLBACK").catch(()=>undefined);throw e;}finally{c.release();}
  }

  /** Persist intent to submit before any external broadcaster is invoked. */
  async beginWithdrawalSubmission(id:string):Promise<void>{
    if(!id.trim())throw new Error("Withdrawal ID is required.");
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const initial=await c.query("SELECT account_id,source_address,asset_address FROM execution_withdrawal_reservations WHERE id=$1",[id]);
      if(!initial.rows[0])throw new Error("Withdrawal reservation not found.");
      const balanceLockKeys=[...new Set([String(initial.rows[0].account_id).toLowerCase(),String(initial.rows[0].source_address??"").toLowerCase()].filter(Boolean))].sort();
      for(const key of balanceLockKeys)await c.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",[key,String(initial.rows[0].asset_address).toLowerCase()]);
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",["treebot-account-restriction",String(initial.rows[0].account_id).toLowerCase()]);
      const q=await c.query("SELECT status,account_id,source_address,asset_address,transaction_hash,nonce,submission_started_at FROM execution_withdrawal_reservations WHERE id=$1 FOR UPDATE",[id]);
      const row=q.rows[0];
      if(!row)throw new Error("Withdrawal reservation not found.");
      if(row.status==="submitting")throw new Error("Withdrawal submission outcome is ambiguous; reconcile it before any retry.");
      if(row.status!=="reserved"||row.transaction_hash||row.nonce!==null)throw new Error("Only an untouched reserved withdrawal can begin submission.");
      if(!row.source_address)throw new Error("Withdrawal submission requires a configured source address.");
      const control=await c.query("SELECT emergency_stop FROM execution_control WHERE id=1 FOR UPDATE");
      if(!control.rows[0]||control.rows[0].emergency_stop!==false)throw new Error("Withdrawal submission blocked by execution emergency stop.");
      const restriction=await c.query("SELECT 1 FROM execution_account_restrictions WHERE account_id IN ($1,LOWER($1),LOWER($2)) AND status='active' LIMIT 1",[row.account_id,row.source_address]);
      if(restriction.rowCount)throw new Error("Withdrawal submission blocked by an active account restriction.");
      await c.query("UPDATE execution_withdrawal_reservations SET status='submitting',submission_started_at=NOW(),updated_at=NOW() WHERE id=$1",[id]);
      await c.query("INSERT INTO execution_withdrawal_audit_events(withdrawal_id,from_status,to_status,event_key,details) VALUES($1,'reserved','submitting',$2,$3::jsonb)",
        [id,"withdrawal:"+id+":submitting",JSON.stringify({releaseEnabled:false,requiresAuthorizedBroadcaster:true})]);
      await c.query("COMMIT");
    }catch(e){await c.query("ROLLBACK").catch(()=>undefined);throw e;}finally{c.release();}
  }

  async recordWithdrawalSubmission(input:{id:string;transactionHash:string;nonce:number}):Promise<void>{
    if(!input.id.trim()||!/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash)||!Number.isSafeInteger(input.nonce)||input.nonce<0)throw new Error("Invalid withdrawal submission identity, transaction hash, or nonce.");
    const txHash=input.transactionHash.toLowerCase(),c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const q=await c.query("SELECT status,transaction_hash,nonce FROM execution_withdrawal_reservations WHERE id=$1 FOR UPDATE",[input.id]);
      const row=q.rows[0];if(!row)throw new Error("Withdrawal reservation not found.");
      if(row.status==="submitted"&&String(row.transaction_hash).toLowerCase()===txHash&&Number(row.nonce)===input.nonce){await c.query("COMMIT");return;}
      if(row.status!=="submitting")throw new Error("Withdrawal submission must be preceded by a durable submitting state.");
      await c.query("UPDATE execution_withdrawal_reservations SET status='submitted',transaction_hash=$2,nonce=$3,submitted_at=NOW(),updated_at=NOW() WHERE id=$1",[input.id,txHash,input.nonce]);
      await c.query("INSERT INTO execution_withdrawal_audit_events(withdrawal_id,from_status,to_status,event_key,transaction_hash,nonce,details) VALUES($1,'submitting','submitted',$2,$3,$4,$5::jsonb)",
        [input.id,"withdrawal:"+input.id+":submitted:"+txHash,txHash,input.nonce,JSON.stringify({submissionRecorded:true})]);
      await c.query("COMMIT");
    }catch(e){await c.query("ROLLBACK").catch(()=>undefined);throw e;}finally{c.release();}
  }

  /** An ambiguous submission remains held and must be reconciled; this never releases funds. */
  async recordWithdrawalUnknown(input:{id:string;reason:string}):Promise<void>{
    if(!input.id.trim()||!input.reason.trim())throw new Error("Withdrawal ID and unknown-state reason are required.");
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const q=await c.query(
        "SELECT status,transaction_hash,nonce,account_id,source_address,asset_address,amount_base_units::text AS amount FROM execution_withdrawal_reservations WHERE id=$1 FOR UPDATE",
        [input.id],
      );
      const row=q.rows[0];if(!row)throw new Error("Withdrawal reservation not found.");
      if(!["submitting","submitted","unknown"].includes(String(row.status)))throw new Error("Only a possibly broadcast withdrawal can enter UNKNOWN.");
      const incident = buildWithdrawalUnknownIncident({
        accountId:String(row.account_id),
        assetAddress:String(row.asset_address),
        amountBaseUnits:String(row.amount),
        withdrawalId:input.id,
        transactionHash:row.transaction_hash ? String(row.transaction_hash) : null,
        nonce:row.nonce === null || row.nonce === undefined ? null : Number(row.nonce),
        reason:input.reason,
      });
      const evidence = JSON.stringify({
        withdrawalId:input.id,
        sourceAddress:row.source_address ? String(row.source_address).toLowerCase() : null,
        assetAddress:incident.assetAddress,
        amountBaseUnits:incident.amountBaseUnits,
        transactionHash:incident.transactionHash,
        nonce:incident.nonce,
        reason:incident.reason,
        retryAllowed:false,
        reservationRetained:true,
        requiresOperatorReconciliation:true,
      });
      await c.query("UPDATE execution_withdrawal_reservations SET status='unknown',failure_reason=$2,updated_at=NOW() WHERE id=$1",
        [input.id,incident.reason]);
      const txHash=incident.transactionHash ?? "unresolved";
      await c.query("INSERT INTO execution_withdrawal_audit_events(withdrawal_id,from_status,to_status,event_key,transaction_hash,nonce,details) VALUES($1,$2,'unknown',$3,$4,$5,$6::jsonb) ON CONFLICT(event_key) DO NOTHING",
        [input.id,String(row.status),"withdrawal:"+input.id+":unknown:"+txHash,row.transaction_hash,row.nonce,evidence]);
      await c.query(
        `INSERT INTO execution_financial_incidents
          (incident_key,incident_type,account_id,asset_address,amount_base_units,chain_id,transaction_hash,log_index,status,details)
         VALUES($1,'settlement_conflict',$2,$3,$4,137,$5,NULL,'open',$6::jsonb)
         ON CONFLICT(incident_key) DO UPDATE SET details=execution_financial_incidents.details || EXCLUDED.details`,
        [incident.incidentKey,incident.accountId,incident.assetAddress,incident.amountBaseUnits,incident.transactionHash,evidence],
      );
      await c.query(
        `INSERT INTO execution_account_restrictions(account_id,restriction_key,restriction_type,status,reason,evidence)
         VALUES($1,$2,'security_incident','active','Withdrawal submission outcome is unknown; operator reconciliation is required.',$3::jsonb)
         ON CONFLICT(restriction_key) DO UPDATE SET status='active',reason=EXCLUDED.reason,evidence=execution_account_restrictions.evidence || EXCLUDED.evidence,resolved_at=NULL,resolved_by=NULL`,
        [incident.accountId,incident.incidentKey+":account",evidence],
      );
      if (row.source_address) {
        await c.query(
          `INSERT INTO execution_account_restrictions(account_id,restriction_key,restriction_type,status,reason,evidence)
           VALUES(LOWER($1),$2,'security_incident','active','Withdrawal submission outcome is unknown; source wallet is restricted pending reconciliation.',$3::jsonb)
           ON CONFLICT(restriction_key) DO UPDATE SET status='active',reason=EXCLUDED.reason,evidence=execution_account_restrictions.evidence || EXCLUDED.evidence,resolved_at=NULL,resolved_by=NULL`,
          [String(row.source_address),incident.incidentKey+":source-wallet",evidence],
        );
      }
      await c.query("UPDATE execution_control SET emergency_stop=TRUE,mismatch_detected_at=NOW(),updated_at=NOW() WHERE id=1");
      await c.query("COMMIT");
    }catch(e){await c.query("ROLLBACK").catch(()=>undefined);throw e;}finally{c.release();}
  }

  /** Cancellation is safe only before the durable submitting transition and requires an authenticated operator at the caller. */
  async cancelWithdrawalBeforeSubmission(input:{id:string;actorId:string;reason:string}):Promise<void>{
    if(!input.id.trim()||!input.actorId.trim()||!input.reason.trim())throw new Error("Withdrawal ID, actor, and cancellation reason are required.");
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const q=await c.query("SELECT status,transaction_hash,nonce,submission_started_at FROM execution_withdrawal_reservations WHERE id=$1 FOR UPDATE",[input.id]);
      const row=q.rows[0];if(!row)throw new Error("Withdrawal reservation not found.");
      if(row.status==="cancelled"){await c.query("COMMIT");return;}
      if(row.status!=="reserved"||row.transaction_hash||row.nonce!==null||row.submission_started_at)throw new Error("Cannot cancel a withdrawal that may have been submitted; reconcile it instead.");
      await c.query("UPDATE execution_withdrawal_reservations SET status='cancelled',failure_reason=$2,updated_at=NOW() WHERE id=$1",[input.id,input.reason.slice(0,500)]);
      await c.query("INSERT INTO execution_withdrawal_audit_events(withdrawal_id,from_status,to_status,event_key,details) VALUES($1,'reserved','cancelled',$2,$3::jsonb) ON CONFLICT(event_key) DO NOTHING",
        [input.id,"withdrawal:"+input.id+":cancelled",JSON.stringify({actorId:input.actorId,reason:input.reason.slice(0,500),broadcastImpossibleByStateMachine:true})]);
      await c.query("COMMIT");
    }catch(e){await c.query("ROLLBACK").catch(()=>undefined);throw e;}finally{c.release();}
  }

  async settleWithdrawal(proof:VerifiedWithdrawalSettlement):Promise<{settled:boolean;status:"confirmed"|"reverted"}>{
    if(!isIssuedWithdrawalSettlement(proof))throw new Error("Withdrawal settlement rejected: trusted canonical receipt proof is required.");
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const initial=await c.query("SELECT account_id,source_address,asset_address FROM execution_withdrawal_reservations WHERE id=$1",[proof.withdrawalId]);
      if(!initial.rows[0])throw new Error("Withdrawal reservation not found.");
      const balanceLockKeys=[...new Set([String(initial.rows[0].account_id).toLowerCase(),String(initial.rows[0].source_address??"").toLowerCase()].filter(Boolean))].sort();
      for(const key of balanceLockKeys)await c.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",[key,String(initial.rows[0].asset_address).toLowerCase()]);
      const q=await c.query("SELECT * FROM execution_withdrawal_reservations WHERE id=$1 FOR UPDATE",[proof.withdrawalId]);
      const row=q.rows[0];if(!row)throw new Error("Withdrawal reservation not found.");
      if(["confirmed","reverted"].includes(String(row.status))){
        const same=String(row.transaction_hash).toLowerCase()===proof.transactionHash.toLowerCase()&&
          Number(row.nonce)===proof.nonce&&String(row.confirmation_block)===proof.blockNumber&&String(row.confirmation_block_hash).toLowerCase()===proof.blockHash.toLowerCase()&&
          row.settlement_status===proof.status&&String(row.settlement_actual_amount)===proof.actualAmountBaseUnits&&String(row.settlement_gas_wei)===proof.gasWei;
        if(!same)throw new Error("Conflicting settlement proof for an already terminal withdrawal.");
        await c.query("COMMIT");return {settled:false,status:proof.status};
      }
      if(!["submitting","submitted","unknown"].includes(String(row.status)))throw new Error("Withdrawal is not eligible for settlement.");
      if(!row.source_address||String(row.source_address).toLowerCase()!==proof.sourceAddress.toLowerCase()||
        String(row.asset_address).toLowerCase()!==proof.tokenAddress.toLowerCase()||
        String(row.recipient_address).toLowerCase()!==proof.recipientAddress.toLowerCase()||
        String(row.amount_base_units)!==proof.reservedAmountBaseUnits||
        (row.nonce!==null&&Number(row.nonce)!==proof.nonce)||
        (row.transaction_hash&&String(row.transaction_hash).toLowerCase()!==proof.transactionHash.toLowerCase())){
        throw new Error("Settlement proof does not match the immutable withdrawal reservation.");
      }
      const nextStatus=proof.status;
      const evidence=JSON.stringify({withdrawalId:proof.withdrawalId,chainId:proof.chainId,transactionHash:proof.transactionHash.toLowerCase(),
        status:proof.status,nonce:proof.nonce,sourceAddress:proof.sourceAddress.toLowerCase(),tokenAddress:proof.tokenAddress.toLowerCase(),
        recipientAddress:proof.recipientAddress.toLowerCase(),reservedAmountBaseUnits:proof.reservedAmountBaseUnits,
        actualAmountBaseUnits:proof.actualAmountBaseUnits,logIndex:proof.logIndex,blockNumber:proof.blockNumber,
        blockHash:proof.blockHash.toLowerCase(),confirmations:proof.confirmations,requiredConfirmations:proof.requiredConfirmations,gasWei:proof.gasWei});
      await c.query(`UPDATE execution_withdrawal_reservations SET status=$2,transaction_hash=COALESCE(transaction_hash,$3),nonce=COALESCE(nonce,$9),
        confirmation_block=$4,confirmation_block_hash=LOWER($5),settlement_actual_amount=$6,settlement_gas_wei=$7,
        settlement_status=$2,settlement_evidence=$8::jsonb,settlement_verified_at=NOW(),settled_at=NOW(),
        failure_reason=CASE WHEN $2='reverted' THEN 'On-chain withdrawal reverted; principal was not debited.' ELSE NULL END,updated_at=NOW()
        WHERE id=$1`,[proof.withdrawalId,nextStatus,proof.transactionHash.toLowerCase(),proof.blockNumber,proof.blockHash,
        proof.actualAmountBaseUnits,proof.gasWei,evidence,proof.nonce]);
      if(proof.status==="confirmed"){
        await c.query(`INSERT INTO execution_ledger_entries(account_id,event_key,entry_type,asset_address,amount_base_units,chain_id,transaction_hash,details)
          VALUES($1,$2,'withdrawal',LOWER($3),-$4::numeric,137,$5,$6::jsonb)`,
          [row.account_id,"withdrawal:137:"+proof.transactionHash.toLowerCase()+":"+proof.withdrawalId+":token",row.asset_address,
            proof.actualAmountBaseUnits,proof.transactionHash.toLowerCase(),evidence]);
        const priorInventoryQ=await c.query("SELECT quantity_base_units::text AS quantity FROM execution_position_inventory WHERE chain_id=137 AND account_id=$1 AND LOWER(asset_address)=LOWER($2) FOR UPDATE",[row.account_id,row.asset_address]);
        const priorInventory=BigInt(priorInventoryQ.rows[0]?.quantity??"0");
        const basisRow=this.accountingQuoteToken?await c.query(
          "SELECT quantity_base_units::text AS quantity,cost_basis_quote_base_units::text AS cost_basis,cost_basis_status FROM execution_open_positions WHERE LOWER(account_id)=LOWER($1) AND LOWER(asset_address)=LOWER($2) AND LOWER(quote_asset_address)=LOWER($3) FOR UPDATE",
          [row.account_id,row.asset_address,this.accountingQuoteToken],
        ):null;
        const basisComplete=!!basisRow?.rows[0]&&basisRow.rows[0].cost_basis_status==="complete"&&BigInt(String(basisRow.rows[0].quantity))===priorInventory&&priorInventory>=BigInt(proof.actualAmountBaseUnits);
        const priorCostBasis=basisComplete?BigInt(String(basisRow?.rows[0]?.cost_basis)):0n;
        let costBasisFailure:string|null=null;
        const inventoryDebit=await c.query(
          `UPDATE execution_position_inventory SET quantity_base_units=quantity_base_units-$3::numeric,updated_at=NOW()
           WHERE chain_id=137 AND account_id=$1 AND LOWER(asset_address)=LOWER($2) AND quantity_base_units >= $3::numeric
           RETURNING quantity_base_units::text AS quantity`,
          [row.account_id,row.asset_address,proof.actualAmountBaseUnits],
        );
        const inventoryQ=await c.query("SELECT quantity_base_units::text AS quantity FROM execution_position_inventory WHERE chain_id=137 AND account_id=$1 AND LOWER(asset_address)=LOWER($2)",[row.account_id,row.asset_address]);
        const inventoryQuantity=BigInt(inventoryQ.rows[0]?.quantity??"0");
        const ledgerQ=await c.query("SELECT COALESCE(SUM(amount_base_units),0)::text AS quantity FROM execution_ledger_entries WHERE LOWER(account_id)=LOWER($1) AND LOWER(asset_address)=LOWER($2) AND entry_type <> 'realized_pnl'",[row.account_id,row.asset_address]);
        const ledgerQuantity=BigInt(ledgerQ.rows[0]?.quantity??"0");
        const discrepancy=ledgerQuantity-inventoryQuantity;
        await c.query(
          "INSERT INTO execution_portfolio_reconciliation(chain_id,account_id,asset_address,ledger_balance,inventory_quantity,discrepancy,status) VALUES(137,$1,LOWER($2),$3::numeric,$4::numeric,$5::numeric,$6)",
          [row.account_id,row.asset_address,ledgerQuantity.toString(),inventoryQuantity.toString(),discrepancy.toString(),discrepancy===0n?"matched":"mismatch"],
        );
        await c.query(
          `INSERT INTO execution_open_positions(account_id,asset_address,quantity_base_units,cost_basis_quote_base_units,quote_asset_address,updated_at,cost_basis_status)
           VALUES($1,LOWER($2),$3::numeric,0,'0x0000000000000000000000000000000000000000',NOW(),'pending')
           ON CONFLICT(account_id,asset_address,quote_asset_address) DO UPDATE SET quantity_base_units=EXCLUDED.quantity_base_units,
             cost_basis_status=CASE WHEN execution_open_positions.cost_basis_status='complete' THEN 'reconciliation_required' ELSE 'pending' END,updated_at=NOW()`,
          [row.account_id,row.asset_address,inventoryQuantity.toString()],
        );
        if(this.accountingQuoteToken&&basisRow?.rows[0]&&basisRow.rows[0].cost_basis_status==="complete"){
          if(basisComplete&&inventoryDebit.rowCount===1){
            const newQuantity=priorInventory-BigInt(proof.actualAmountBaseUnits);
            const allocated=this.accountingQuoteToken===String(row.asset_address).toLowerCase()
              ?BigInt(proof.actualAmountBaseUnits)
              :(priorCostBasis*BigInt(proof.actualAmountBaseUnits))/priorInventory;
            const newCost=this.accountingQuoteToken===String(row.asset_address).toLowerCase()
              ?(priorCostBasis>=allocated?priorCostBasis-allocated:0n)
              :priorCostBasis-allocated;
            await c.query(
              "UPDATE execution_open_positions SET quantity_base_units=$4::numeric,cost_basis_quote_base_units=$5::numeric,cost_basis_status='complete',updated_at=NOW() WHERE LOWER(account_id)=LOWER($1) AND LOWER(asset_address)=LOWER($2) AND LOWER(quote_asset_address)=LOWER($3)",
              [row.account_id,row.asset_address,this.accountingQuoteToken,newQuantity.toString(),newCost.toString()],
            );
            if(this.accountingQuoteToken===String(row.asset_address).toLowerCase()&&priorCostBasis<allocated){
              costBasisFailure="Quote-token cost basis fell below the withdrawn amount.";
            }
          }else{
            await c.query("UPDATE execution_open_positions SET cost_basis_status='reconciliation_required',updated_at=NOW() WHERE LOWER(account_id)=LOWER($1) AND LOWER(asset_address)=LOWER($2) AND LOWER(quote_asset_address)=LOWER($3)",
              [row.account_id,row.asset_address,this.accountingQuoteToken]);
            costBasisFailure="Withdrawal settlement could not reconcile complete cost basis with the inventory quantity.";
          }
        }
        if(costBasisFailure){
          const incidentKey="withdrawal-cost-basis:137:"+proof.transactionHash.toLowerCase()+":"+proof.withdrawalId;
          const details=JSON.stringify({withdrawalId:proof.withdrawalId,transactionHash:proof.transactionHash,assetAddress:row.asset_address,cause:costBasisFailure});
          await c.query(
            `INSERT INTO execution_financial_incidents(incident_key,incident_type,account_id,asset_address,amount_base_units,chain_id,transaction_hash,log_index,status,details)
             VALUES($1,'settlement_conflict',$2,LOWER($3),$4::numeric,137,$5,$6,'open',$7::jsonb) ON CONFLICT(incident_key) DO NOTHING`,
            [incidentKey,row.account_id,row.asset_address,proof.actualAmountBaseUnits,proof.transactionHash.toLowerCase(),proof.logIndex,details],
          );
          await c.query(
            `INSERT INTO execution_account_restrictions(account_id,restriction_key,restriction_type,status,reason,evidence)
             VALUES($1,$2,'operator_hold','active','Withdrawal cost basis requires reconciliation.',$3::jsonb) ON CONFLICT(restriction_key) DO NOTHING`,
            [row.account_id,incidentKey,details],
          );
          await c.query("UPDATE execution_control SET emergency_stop=TRUE WHERE id=1");
        }
        if(discrepancy!==0n||inventoryDebit.rowCount!==1){
          const incidentKey="withdrawal-ledger-mismatch:137:"+proof.transactionHash.toLowerCase()+":"+proof.withdrawalId;
          const amount=(discrepancy<0n?-discrepancy:discrepancy).toString()==="0"?proof.actualAmountBaseUnits:(discrepancy<0n?-discrepancy:discrepancy).toString();
          const details=JSON.stringify({withdrawalId:proof.withdrawalId,transactionHash:proof.transactionHash,assetAddress:row.asset_address,
            ledgerBalance:ledgerQuantity.toString(),inventoryQuantity:inventoryQuantity.toString(),discrepancy:discrepancy.toString(),inventoryDebitApplied:inventoryDebit.rowCount===1});
          await c.query(
            `INSERT INTO execution_financial_incidents(incident_key,incident_type,account_id,asset_address,amount_base_units,chain_id,transaction_hash,log_index,status,details)
             VALUES($1,'ledger_mismatch',$2,LOWER($3),$4::numeric,137,$5,$6,'open',$7::jsonb) ON CONFLICT(incident_key) DO NOTHING`,
            [incidentKey,row.account_id,row.asset_address,amount,proof.transactionHash.toLowerCase(),proof.logIndex,details],
          );
          for(const restrictedAccount of [...new Set([String(row.account_id),String(row.source_address)])]){
            await c.query(
              `INSERT INTO execution_account_restrictions(account_id,restriction_key,restriction_type,status,reason,evidence)
               VALUES($1,$2,'ledger_mismatch','active','Withdrawal settlement exposed a ledger/inventory mismatch.',$3::jsonb) ON CONFLICT(restriction_key) DO NOTHING`,
              [restrictedAccount,incidentKey+":"+restrictedAccount.toLowerCase(),details],
            );
          }
          await c.query("UPDATE execution_control SET emergency_stop=TRUE WHERE id=1");
        }
      }
      if(BigInt(proof.gasWei)>0n){
        await c.query(`INSERT INTO execution_ledger_entries(account_id,event_key,entry_type,asset_address,amount_base_units,chain_id,transaction_hash,details)
          VALUES($1,$2,'gas','0x0000000000000000000000000000000000000000',-$3::numeric,137,$4,$5::jsonb)`,
          [row.account_id,"withdrawal:137:"+proof.transactionHash.toLowerCase()+":"+proof.withdrawalId+":gas",proof.gasWei,proof.transactionHash.toLowerCase(),evidence]);
      }
      await c.query("INSERT INTO execution_withdrawal_audit_events(withdrawal_id,from_status,to_status,event_key,transaction_hash,nonce,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
        [proof.withdrawalId,String(row.status),nextStatus,"withdrawal:"+proof.withdrawalId+":settled:"+proof.transactionHash.toLowerCase(),
          proof.transactionHash.toLowerCase(),proof.nonce,evidence]);
      await c.query("COMMIT");return {settled:true,status:proof.status};
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
      "SELECT COALESCE(SUM(amount_base_units),0)::text AS balance FROM execution_ledger_entries WHERE account_id=$1 AND LOWER(asset_address)=LOWER($2) AND entry_type <> 'realized_pnl'",
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

  /**
   * Returns exact ledger/inventory quantities. P&L is null unless both a complete quote-token cost basis
   * and a fresh valuation from an explicitly trusted valuation source exist.
   * Valuation price ratios are quote-token base units per asset base unit.
   */
  async getPortfolioSnapshot(accountId:string,quoteAssetAddress=this.accountingQuoteToken??""):Promise<PortfolioSnapshot>{
    if(!accountId.trim()||!/^0x[0-9a-fA-F]{40}$/.test(quoteAssetAddress))throw new Error("A valid account and canonical quote token are required for portfolio accounting.");
    const quote=quoteAssetAddress.toLowerCase();
    const [ledgerRows,inventoryRows,pnlRows,pendingRows]=await Promise.all([
      this.pool.query("SELECT LOWER(asset_address) AS asset,COALESCE(SUM(amount_base_units),0)::text AS quantity FROM execution_ledger_entries WHERE LOWER(account_id)=LOWER($1) AND entry_type <> 'realized_pnl' AND LOWER(asset_address)<>'0x0000000000000000000000000000000000000000' GROUP BY LOWER(asset_address)",[accountId]),
      this.pool.query("SELECT LOWER(asset_address) AS asset,quantity_base_units::text AS quantity FROM execution_position_inventory WHERE chain_id=137 AND LOWER(account_id)=LOWER($1)",[accountId]),
      this.pool.query("SELECT LOWER(quote_asset_address) AS quote_asset,SUM(realized_pnl_quote_base_units)::text AS pnl FROM execution_trade_accounting WHERE LOWER(account_id)=LOWER($1) AND accounting_status='complete' AND realized_pnl_quote_base_units IS NOT NULL AND quote_asset_address IS NOT NULL GROUP BY LOWER(quote_asset_address)",[accountId]),
      this.pool.query("SELECT COUNT(*)::text AS count FROM execution_trade_accounting WHERE LOWER(account_id)=LOWER($1) AND accounting_status IN('pending','reconciliation_required')",[accountId]),
    ]);
    const ledger=new Map<string,string>(ledgerRows.rows.map((row)=>[String(row.asset),String(row.quantity)]));
    const inventory=new Map<string,string>(inventoryRows.rows.map((row)=>[String(row.asset),String(row.quantity)]));
    const assets=[...new Set([...ledger.keys(),...inventory.keys()])].sort();
    const snapshots:PortfolioAssetSnapshot[]=[];
    for(const asset of assets){
      const ledgerBalance=ledger.get(asset)??"0";
      const inventoryQuantity=inventory.get(asset)??"0";
      const quantityMatchesLedger=BigInt(ledgerBalance)===BigInt(inventoryQuantity);
      let costBasisStatus:PortfolioAssetSnapshot["costBasisStatus"]="pending";
      let costBasisQuoteAsset:string|null=null;
      let costBasisQuoteBaseUnits:string|null=null;
      if(asset===quote){
        costBasisStatus="complete";costBasisQuoteAsset=quote;costBasisQuoteBaseUnits=inventoryQuantity;
      }else{
        const basis=await this.pool.query(
          "SELECT quantity_base_units::text AS quantity,cost_basis_quote_base_units::text AS cost_basis,cost_basis_status FROM execution_open_positions WHERE LOWER(account_id)=LOWER($1) AND LOWER(asset_address)=LOWER($2) AND LOWER(quote_asset_address)=LOWER($3)",
          [accountId,asset,quote],
        );
        const row=basis.rows[0];
        if(row?.cost_basis_status==="reconciliation_required")costBasisStatus="reconciliation_required";
        else if(row?.cost_basis_status==="complete"&&BigInt(String(row.quantity))===BigInt(inventoryQuantity)){
          costBasisStatus="complete";costBasisQuoteAsset=quote;costBasisQuoteBaseUnits=String(row.cost_basis);
        }
      }
      let marketValueQuoteBaseUnits:string|null=null,unrealizedPnlQuoteBaseUnits:string|null=null;
      let valuationSource:string|null=null,valuationObservedAt:string|null=null;
      if(asset===quote){
        marketValueQuoteBaseUnits=inventoryQuantity;valuationSource="quote-token-par";valuationObservedAt=new Date().toISOString();
      }else if(this.trustedValuationSources.size){
        const valuation=await this.pool.query(
          "SELECT valuation_source,price_numerator::text AS numerator,price_denominator::text AS denominator,observed_at::text AS observed_at FROM execution_asset_valuations WHERE LOWER(account_id)=LOWER($1) AND LOWER(asset_address)=LOWER($2) AND LOWER(quote_asset_address)=LOWER($3) AND freshness_deadline>NOW() AND valuation_source=ANY($4::text[]) ORDER BY observed_at DESC LIMIT 1",
          [accountId,asset,quote,[...this.trustedValuationSources]],
        );
        if(valuation.rows[0]){
          const row=valuation.rows[0];
          const numerator=BigInt(String(row.numerator)),denominator=BigInt(String(row.denominator));
          if(denominator>0n){
            marketValueQuoteBaseUnits=((BigInt(inventoryQuantity)*numerator)/denominator).toString();
            valuationSource=String(row.valuation_source);valuationObservedAt=String(row.observed_at);
          }
        }
      }
      if(quantityMatchesLedger&&costBasisStatus==="complete"&&marketValueQuoteBaseUnits!==null&&costBasisQuoteBaseUnits!==null){
        unrealizedPnlQuoteBaseUnits=(BigInt(marketValueQuoteBaseUnits)-BigInt(costBasisQuoteBaseUnits)).toString();
      }
      snapshots.push({assetAddress:asset,ledgerBalance,inventoryQuantity,quantityMatchesLedger,costBasisStatus,costBasisQuoteAsset,costBasisQuoteBaseUnits,
        marketValueQuoteBaseUnits,unrealizedPnlQuoteBaseUnits,valuationSource,valuationObservedAt});
    }
    const valuationComplete=snapshots.every((asset)=>asset.quantityMatchesLedger&&asset.marketValueQuoteBaseUnits!==null&&asset.unrealizedPnlQuoteBaseUnits!==null);
    const totalMarketValueQuoteBaseUnits=valuationComplete?snapshots.reduce((sum,asset)=>sum+BigInt(asset.marketValueQuoteBaseUnits!),0n).toString():null;
    const totalUnrealizedPnlQuoteBaseUnits=valuationComplete?snapshots.reduce((sum,asset)=>sum+BigInt(asset.unrealizedPnlQuoteBaseUnits!),0n).toString():null;
    return {
      accountId,quoteAssetAddress:quote,assets:snapshots,
      realizedPnlBeforeGasByQuoteAsset:pnlRows.rows.map((row)=>({quoteAssetAddress:String(row.quote_asset),realizedPnlBaseUnits:String(row.pnl)})),
      pendingTradeAccountingCount:Number(pendingRows.rows[0]?.count??0),valuationComplete,
      totalMarketValueQuoteBaseUnits,totalUnrealizedPnlQuoteBaseUnits,
    };
  }

  async recordAssetValuation(proof:VerifiedAssetValuation):Promise<{inserted:boolean}>{
    if(!isIssuedVerifiedAssetValuation(proof))throw new Error("Asset valuation proof was not issued by the trusted dual-provider Chainlink verifier.");
    if(!this.trustedValuationSources.has(proof.valuationSource))throw new Error("Valuation source is not in the explicit trusted-source allowlist.");
    if(!this.accountingQuoteToken||proof.quoteAssetAddress.toLowerCase()!==this.accountingQuoteToken)throw new Error("Valuation quote asset does not match the configured canonical accounting quote token.");
    const observedAt=new Date(proof.observedAt),freshnessDeadline=new Date(proof.freshnessDeadline);
    if(!Number.isFinite(observedAt.getTime())||!Number.isFinite(freshnessDeadline.getTime())||freshnessDeadline.getTime()<=Date.now())
      throw new Error("Valuation proof is malformed or already stale.");
    const c=await this.pool.connect();
    try{
      await c.query("BEGIN");
      const inserted=await c.query(
        `INSERT INTO execution_asset_valuations(account_id,asset_address,valuation_source,quote_asset_address,price_numerator,price_denominator,token_decimals,observed_at,freshness_deadline)
         VALUES($1,LOWER($2),$3,LOWER($4),$5::numeric,$6::numeric,$7,$8,$9)
         ON CONFLICT(account_id,asset_address,observed_at) DO NOTHING RETURNING account_id`,
        [proof.accountId,proof.assetAddress,proof.valuationSource,proof.quoteAssetAddress,proof.priceNumerator,proof.priceDenominator,proof.tokenDecimals,observedAt.toISOString(),freshnessDeadline.toISOString()],
      );
      if(inserted.rowCount===0){
        const existing=await c.query(
          "SELECT valuation_source,LOWER(quote_asset_address) AS quote_asset,price_numerator::text AS numerator,price_denominator::text AS denominator,token_decimals,freshness_deadline FROM execution_asset_valuations WHERE account_id=$1 AND LOWER(asset_address)=LOWER($2) AND observed_at=$3 FOR UPDATE",
          [proof.accountId,proof.assetAddress,observedAt.toISOString()],
        );
        const row=existing.rows[0];
        if(!row||row.valuation_source!==proof.valuationSource||row.quote_asset!==proof.quoteAssetAddress.toLowerCase()||
          String(row.numerator)!==proof.priceNumerator||String(row.denominator)!==proof.priceDenominator||Number(row.token_decimals)!==proof.tokenDecimals||
          new Date(row.freshness_deadline).getTime()!==freshnessDeadline.getTime()){
          throw new Error("Conflicting immutable valuation evidence already exists for this account, asset, and observation time.");
        }
        await c.query("COMMIT");return {inserted:false};
      }
      await c.query(
        `INSERT INTO execution_asset_valuation_evidence(account_id,asset_address,observed_at,chain_id,block_number,block_hash,
          asset_feed_address,quote_feed_address,asset_round_id,quote_round_id,asset_answer,quote_answer,asset_feed_decimals,quote_feed_decimals,confirmations,required_confirmations)
         VALUES($1,LOWER($2),$3,137,$4::numeric,$5,LOWER($6),LOWER($7),$8::numeric,$9::numeric,$10::numeric,$11::numeric,$12,$13,$14,$15)`,
        [proof.accountId,proof.assetAddress,observedAt.toISOString(),proof.blockNumber,proof.blockHash,proof.assetFeedAddress,proof.quoteFeedAddress,
          proof.assetRoundId,proof.quoteRoundId,proof.assetAnswer,proof.quoteAnswer,proof.assetFeedDecimals,proof.quoteFeedDecimals,proof.confirmations,proof.requiredConfirmations],
      );
      await c.query("COMMIT");return {inserted:true};
    }catch(error){await c.query("ROLLBACK").catch(()=>undefined);throw error;}finally{c.release();}
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
  private readonly accountingQuoteToken:string|null;
  constructor(private readonly pool: Pool,accountingQuoteToken=process.env.TREEBOT_ACCOUNTING_QUOTE_TOKEN??""){
    this.accountingQuoteToken=/^0x[0-9a-fA-F]{40}$/.test(accountingQuoteToken)?accountingQuoteToken.toLowerCase():null;
  }

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
      proof?: import("./deposit-proof").VerifiedDepositProof;
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
      let credited = 0;
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
        const proof = event.proof;
        if (proof !== undefined) {
          if (
            !isIssuedVerifiedDepositProof(proof) ||
            proof.chainId !== event.chainId ||
            proof.transactionHash.toLowerCase() !== event.transactionHash.toLowerCase() ||
            proof.receiptTransactionHash.toLowerCase() !== event.transactionHash.toLowerCase() ||
            proof.receiptStatus !== "success" ||
            proof.receiptBlockNumber !== blockNumber.toString() ||
            proof.receiptBlockHash.toLowerCase() !== event.blockHash.toLowerCase() ||
            proof.logIndex !== event.logIndex ||
            proof.accountId !== event.accountId ||
            proof.tokenAddress.toLowerCase() !== event.assetAddress.toLowerCase() ||
            proof.senderAddress.toLowerCase() !== event.senderAddress.toLowerCase() ||
            proof.recipientAddress.toLowerCase() !== event.vaultAddress.toLowerCase() ||
            proof.amountBaseUnits !== amount.toString() ||
            proof.blockNumber !== blockNumber.toString() ||
            proof.blockHash.toLowerCase() !== event.blockHash.toLowerCase() ||
            event.confirmations < event.requiredConfirmations ||
            row.status !== "confirmed"
          ) {
            throw new Error("Deposit credit rejected: scanner proof is absent, untrusted, or does not match the persisted event.");
          }
          // Serializable transaction plus account/wallet restriction checks closes the
          // credit path against concurrent incident handling. Every financial write below
          // and the checkpoint update commit or roll back together.
          const restrictionKeys = [event.accountId.toLowerCase(), event.senderAddress.toLowerCase()].sort();
          for (const restrictionKey of restrictionKeys) {
            await c.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", ["treebot-account-restriction", restrictionKey]);
          }
          const restricted = await c.query(
            `SELECT 1 FROM execution_account_restrictions
             WHERE status='active' AND account_id IN ($1,LOWER($1),LOWER($2)) LIMIT 1`,
            [event.accountId, event.senderAddress],
          );
          if (restricted.rowCount) throw new Error("Deposit credit blocked by an active account or wallet restriction.");
          const eventKey = `deposit:137:${event.transactionHash.toLowerCase()}:${event.logIndex}`;
          const deposit = await c.query(
            `INSERT INTO execution_deposit_events
              (chain_id,transaction_hash,log_index,account_id,asset_address,amount_base_units,from_address,to_address,
               block_number,confirmed_at,block_hash,vault_address,token_decimals,receipt_status)
             VALUES(137,$1,$2,$3,LOWER($4),$5,LOWER($6),LOWER($7),$8,NOW(),LOWER($9),LOWER($10),$11,'success')
             ON CONFLICT(chain_id,transaction_hash,log_index) DO NOTHING RETURNING transaction_hash`,
            [event.transactionHash.toLowerCase(),event.logIndex,event.accountId,event.assetAddress,amount.toString(),
              event.senderAddress,event.vaultAddress,blockNumber.toString(),event.blockHash,event.vaultAddress,proof.tokenDecimals],
          );
          if (deposit.rowCount === 1) {
            await c.query(
              `INSERT INTO execution_ledger_entries
                (account_id,event_key,entry_type,asset_address,amount_base_units,chain_id,transaction_hash,details)
               VALUES($1,$2,'deposit',LOWER($3),$4,137,$5,$6::jsonb)`,
              [event.accountId,eventKey,event.assetAddress,amount.toString(),event.transactionHash.toLowerCase(),
                JSON.stringify({ source:"verified_polygon_transfer",logIndex:event.logIndex,blockNumber:blockNumber.toString(),
                  blockHash:event.blockHash.toLowerCase(),sender:event.senderAddress.toLowerCase(),recipient:event.vaultAddress.toLowerCase(),
                  tokenDecimals:proof.tokenDecimals,watcherKey:input.watcherKey })],
            );
            const priorInventoryQ=await c.query(
              "SELECT quantity_base_units::text AS quantity FROM execution_position_inventory WHERE chain_id=137 AND account_id=$1 AND LOWER(asset_address)=LOWER($2) FOR UPDATE",
              [event.accountId,event.assetAddress],
            );
            const priorInventory=BigInt(priorInventoryQ.rows[0]?.quantity??"0");
            const quotePosition=this.accountingQuoteToken?await c.query(
              "SELECT quantity_base_units::text AS quantity,cost_basis_quote_base_units::text AS cost_basis,cost_basis_status FROM execution_open_positions WHERE LOWER(account_id)=LOWER($1) AND LOWER(asset_address)=LOWER($2) AND LOWER(quote_asset_address)=LOWER($3) FOR UPDATE",
              [event.accountId,event.assetAddress,this.accountingQuoteToken],
            ):null;
            const quoteBasisComplete=!!this.accountingQuoteToken&&event.assetAddress.toLowerCase()===this.accountingQuoteToken&&
              ((!!quotePosition?.rows[0]&&quotePosition.rows[0].cost_basis_status==="complete"&&BigInt(String(quotePosition.rows[0].quantity))===priorInventory)||
               (!quotePosition?.rows[0]&&priorInventory===0n));
            const priorCostBasis=quoteBasisComplete&&quotePosition?.rows[0]?BigInt(String(quotePosition.rows[0].cost_basis)):0n;
            const inventory=await c.query(
              `INSERT INTO execution_position_inventory(chain_id,account_id,asset_address,quantity_base_units,updated_at)
               VALUES(137,$1,LOWER($2),$3::numeric,NOW())
               ON CONFLICT(chain_id,account_id,asset_address) DO UPDATE SET
                 quantity_base_units=execution_position_inventory.quantity_base_units+EXCLUDED.quantity_base_units,updated_at=NOW()
               RETURNING quantity_base_units::text AS quantity`,
              [event.accountId,event.assetAddress,amount.toString()],
            );
            await c.query(
              `INSERT INTO execution_open_positions(account_id,asset_address,quantity_base_units,cost_basis_quote_base_units,quote_asset_address,updated_at,cost_basis_status)
               VALUES($1,LOWER($2),$3::numeric,0,'0x0000000000000000000000000000000000000000',NOW(),'pending')
               ON CONFLICT(account_id,asset_address,quote_asset_address) DO UPDATE SET
                 quantity_base_units=EXCLUDED.quantity_base_units,
                 cost_basis_status=CASE WHEN execution_open_positions.cost_basis_status='complete' THEN 'reconciliation_required' ELSE 'pending' END,
                 updated_at=NOW()`,
              [event.accountId,event.assetAddress,String(inventory.rows[0]?.quantity??amount.toString())],
            );
            if(this.accountingQuoteToken&&event.assetAddress.toLowerCase()===this.accountingQuoteToken){
              await c.query(
                `INSERT INTO execution_open_positions(account_id,asset_address,quantity_base_units,cost_basis_quote_base_units,quote_asset_address,updated_at,cost_basis_status)
                 VALUES($1,LOWER($2),$3::numeric,$4::numeric,$5,NOW(),$6)
                 ON CONFLICT(account_id,asset_address,quote_asset_address) DO UPDATE SET
                   quantity_base_units=EXCLUDED.quantity_base_units,cost_basis_quote_base_units=EXCLUDED.cost_basis_quote_base_units,
                   cost_basis_status=EXCLUDED.cost_basis_status,updated_at=NOW()`,
                [event.accountId,event.assetAddress,String(inventory.rows[0]?.quantity??amount.toString()),
                  (quoteBasisComplete?priorCostBasis+amount:0n).toString(),this.accountingQuoteToken,quoteBasisComplete?"complete":"pending"],
              );
            }else if(this.accountingQuoteToken){
              await c.query(
                "UPDATE execution_open_positions SET cost_basis_status='reconciliation_required',updated_at=NOW() WHERE LOWER(account_id)=LOWER($1) AND LOWER(asset_address)=LOWER($2) AND LOWER(quote_asset_address)=LOWER($3) AND cost_basis_status='complete'",
                [event.accountId,event.assetAddress,this.accountingQuoteToken],
              );
            }
            const marked = await c.query(
              `UPDATE execution_deposit_lifecycle SET credited_event_key=$4,token_decimals=$5,updated_at=NOW()
               WHERE chain_id=137 AND watcher_key=$1 AND transaction_hash=$2 AND log_index=$3
                 AND credited_event_key IS NULL AND status='confirmed' RETURNING transaction_hash`,
              [input.watcherKey,event.transactionHash.toLowerCase(),event.logIndex,eventKey,proof.tokenDecimals],
            );
            if (marked.rowCount !== 1) throw new Error("Deposit lifecycle could not be atomically marked credited.");
            await c.query(
              "INSERT INTO execution_audit_events(event_type,details) VALUES('deposit_credited',$1::jsonb)",
              [JSON.stringify({accountId:event.accountId,eventKey,transactionHash:event.transactionHash.toLowerCase(),
                logIndex:event.logIndex,amountBaseUnits:amount.toString(),assetAddress:event.assetAddress.toLowerCase(),
                tokenDecimals:proof.tokenDecimals,watcherKey:input.watcherKey})],
            );
            credited++;
          } else {
            const existing = await c.query(
              `SELECT account_id,LOWER(asset_address) AS asset_address,amount_base_units::text,LOWER(from_address) AS from_address,
                      LOWER(to_address) AS to_address,LOWER(vault_address) AS vault_address,block_number::text,LOWER(block_hash) AS block_hash,token_decimals,receipt_status
               FROM execution_deposit_events WHERE chain_id=137 AND transaction_hash=$1 AND log_index=$2`,
              [event.transactionHash.toLowerCase(),event.logIndex],
            );
            const prior = existing.rows[0];
            if (!prior || prior.account_id !== event.accountId ||
                prior.asset_address !== event.assetAddress.toLowerCase() || prior.amount_base_units !== amount.toString() ||
                prior.from_address !== event.senderAddress.toLowerCase() || prior.to_address !== event.vaultAddress.toLowerCase() || prior.vault_address !== event.vaultAddress.toLowerCase() ||
                prior.block_number !== blockNumber.toString() || prior.block_hash !== event.blockHash.toLowerCase() ||
                Number(prior.token_decimals) !== proof.tokenDecimals || prior.receipt_status !== proof.receiptStatus) {
              throw new Error("Duplicate deposit identity conflicts with its immutable verified funding provenance.");
            }
            const ledger = await c.query("SELECT 1 FROM execution_ledger_entries WHERE event_key=$1", [eventKey]);
            if (!ledger.rowCount) throw new Error("Deposit event exists without its atomic ledger credit; reconciliation is required.");
            await c.query(
              `UPDATE execution_deposit_lifecycle SET credited_event_key=$3,token_decimals=$4,updated_at=NOW()
               WHERE chain_id=137 AND watcher_key=$1 AND transaction_hash=$2 AND credited_event_key IS NULL`,
              [input.watcherKey,event.transactionHash.toLowerCase(),eventKey,proof.tokenDecimals],
            );
          }
        }
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
          const restrictionKeys = [event.accountId.toLowerCase(), event.senderAddress.toLowerCase()].sort();
          for (const restrictionKey of restrictionKeys) {
            await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", ["treebot-account-restriction", restrictionKey]);
          }
          await client.query(
            `UPDATE execution_deposit_lifecycle SET status='reconciliation_required',updated_at=NOW()
             WHERE chain_id=$1 AND watcher_key=$2 AND transaction_hash=$3 AND log_index=$4`,
            [input.chainId,input.watcherKey,event.transactionHash.toLowerCase(),event.logIndex],
          );
          await client.query(
            "UPDATE execution_control SET emergency_stop=TRUE,mismatch_detected_at=NOW(),updated_at=NOW() WHERE id=1",
          );
          const incidentKey = `deposit-reorg:137:${event.transactionHash.toLowerCase()}:${event.logIndex}`;
          const evidence = {
            watcherKey: input.watcherKey,
            accountId: event.accountId,
            assetAddress: event.assetAddress,
            transactionHash: event.transactionHash,
            logIndex: event.logIndex,
            amountBaseUnits: event.amountBaseUnits,
            blockNumber: event.blockNumber,
            blockHash: event.blockHash,
            reason: input.reason,
          };
          await client.query(
            `INSERT INTO execution_financial_incidents
              (incident_key,incident_type,account_id,asset_address,amount_base_units,chain_id,transaction_hash,log_index,details)
             VALUES($1,'deposit_reorg_after_credit',$2,LOWER($3),$4,137,$5,$6,$7::jsonb)
             ON CONFLICT(incident_key) DO NOTHING`,
            [incidentKey,event.accountId,event.assetAddress,event.amountBaseUnits,event.transactionHash.toLowerCase(),event.logIndex,JSON.stringify(evidence)],
          );
          await client.query(
            `INSERT INTO execution_account_restrictions(account_id,restriction_key,restriction_type,reason,evidence)
             VALUES($1,$2,'deposit_reorg',$3,$4::jsonb)
             ON CONFLICT(restriction_key) DO NOTHING`,
            [event.accountId,`${incidentKey}:account`,"Credited deposit was orphaned; account frozen pending financial reconciliation.",JSON.stringify(evidence)],
          );
          // Also restrict the depositing sender wallet so a distinct account-ID mapping
          // cannot bypass the restriction at execution-intent creation.
          await client.query(
            `INSERT INTO execution_account_restrictions(account_id,restriction_key,restriction_type,reason,evidence)
             VALUES(LOWER($1),$2,'deposit_reorg',$3,$4::jsonb)
             ON CONFLICT(restriction_key) DO NOTHING`,
            [event.senderAddress,`${incidentKey}:sender`,"Credited deposit was orphaned; sender wallet frozen pending financial reconciliation.",JSON.stringify(evidence)],
          );
          await client.query(
            "INSERT INTO execution_audit_events(event_type,details) VALUES('orphaned_deposit_requires_reconciliation',$1::jsonb)",
            [JSON.stringify(evidence)],
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
