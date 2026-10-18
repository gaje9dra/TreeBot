import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { Address, Hash } from "viem";
import { PostgresDepositScannerStore, PostgresExecutionStore } from "../postgres";

const enabled = process.env.TREEBOT_RUN_POSTGRES_INTEGRATION === "true";
const describePostgres = enabled ? describe : describe.skip;
const prefix = `phase24c-${process.pid}-${Date.now()}`;
const vault = "0x0000000000000000000000000000000000000010" as Address;
const token = "0x0000000000000000000000000000000000000020" as Address;
const sender = "0x0000000000000000000000000000000000000030" as Address;
const hashSeed = BigInt(Date.now()) * 1_000_000n + BigInt(process.pid);
const hash = (n: number) => `0x${(hashSeed + BigInt(n)).toString(16).padStart(64, "0")}` as Hash;

let pool: Pool;
let store: PostgresDepositScannerStore;

describePostgres("PostgresDepositScannerStore integration", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for PostgreSQL integration tests.");
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    store = new PostgresDepositScannerStore(pool);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query("DELETE FROM execution_account_restrictions WHERE account_id LIKE $1 OR evidence->>'accountId' LIKE $1", [`${prefix}%`]);
    await pool.query("DELETE FROM execution_financial_incidents WHERE account_id LIKE $1 OR details->>'accountId' LIKE $1", [`${prefix}%`]);
    await pool.query("DELETE FROM execution_ledger_entries WHERE account_id LIKE $1", [`${prefix}%`]);
    await pool.query("DELETE FROM execution_audit_events WHERE transaction_id LIKE $1", [`${prefix}%`]);
    await pool.query("DELETE FROM execution_transactions WHERE id LIKE $1", [`${prefix}%`]);
    await pool.query("DELETE FROM execution_authorizations WHERE id LIKE $1", [`${prefix}%`]);
    await pool.query("DELETE FROM execution_deposit_lifecycle WHERE watcher_key LIKE $1", [`${prefix}%`]);
    await pool.query("DELETE FROM execution_chain_watcher_state WHERE watcher_key LIKE $1", [`${prefix}%`]);
    await pool.query("DELETE FROM execution_audit_events WHERE details->>'watcherKey' LIKE $1", [`${prefix}%`]);
    await pool.end();
  });

  async function observation(watcherKey: string, txNo: number, blockNo = 100) {
    return store.commitScannedRange({
      chainId: 137,
      watcherKey,
      expectedNextBlock: BigInt(blockNo),
      nextBlock: BigInt(blockNo + 1),
      lastScannedBlockHash: hash(blockNo),
      observations: [{
        chainId: 137,
        transactionHash: hash(txNo),
        logIndex: 0,
        accountId: `${prefix}-account-${txNo}`,
        assetAddress: token,
        senderAddress: sender,
        vaultAddress: vault,
        amountBaseUnits: "1000",
        blockNumber: String(blockNo),
        blockHash: hash(blockNo),
        confirmations: 64,
        requiredConfirmations: 64,
      }],
    });
  }

  it("persists observations without creating spendable ledger credits", async () => {
    const watcherKey = `${prefix}-observe`;
    await store.getOrCreateCheckpoint({ chainId: 137, watcherKey, initialBlock: 100n });
    await expect(observation(watcherKey, 101)).resolves.toEqual({ inserted: 1, credited: 0, reversed: 0 });
    const ledger = await pool.query("SELECT event_key FROM execution_ledger_entries WHERE account_id=$1", [`${prefix}-account-101`]);
    expect(ledger.rows).toHaveLength(0);
    const lifecycle = await pool.query(
      "SELECT status,credited_event_key,watcher_key FROM execution_deposit_lifecycle WHERE chain_id=137 AND transaction_hash=$1",
      [hash(101)],
    );
    expect(lifecycle.rows[0]).toMatchObject({ status: "confirmed", credited_event_key: null, watcher_key: watcherKey });
  });

  it("rolls back earlier observations and checkpoint advancement if a later event is invalid", async () => {
    const watcherKey = `${prefix}-rollback`;
    await store.getOrCreateCheckpoint({ chainId: 137, watcherKey, initialBlock: 100n });
    await expect(store.commitScannedRange({
      chainId: 137,
      watcherKey,
      expectedNextBlock: 100n,
      nextBlock: 101n,
      lastScannedBlockHash: hash(100),
      observations: [
        {
          chainId: 137, transactionHash: hash(111), logIndex: 0, accountId: `${prefix}-account-111`,
          assetAddress: token, senderAddress: sender, vaultAddress: vault, amountBaseUnits: "1000",
          blockNumber: "100", blockHash: hash(100), confirmations: 64, requiredConfirmations: 64,
        },
        {
          chainId: 137, transactionHash: hash(112), logIndex: 0, accountId: `${prefix}-account-112`,
          assetAddress: token, senderAddress: sender, vaultAddress: vault, amountBaseUnits: "0",
          blockNumber: "100", blockHash: hash(100), confirmations: 64, requiredConfirmations: 64,
        },
      ],
    })).rejects.toThrow(/positive/);
    const state = await pool.query("SELECT next_block::text FROM execution_chain_watcher_state WHERE chain_id=137 AND watcher_key=$1", [watcherKey]);
    const events = await pool.query("SELECT transaction_hash FROM execution_deposit_lifecycle WHERE chain_id=137 AND watcher_key=$1", [watcherKey]);
    expect(state.rows[0].next_block).toBe("100");
    expect(events.rows).toHaveLength(0);
  });

  it("allows only one concurrent range commit for a checkpoint", async () => {
    const watcherKey = `${prefix}-race`;
    await store.getOrCreateCheckpoint({ chainId: 137, watcherKey, initialBlock: 500n });
    const attempt = () => store.commitScannedRange({
      chainId: 137, watcherKey, expectedNextBlock: 500n, nextBlock: 501n, lastScannedBlockHash: hash(500), observations: [],
    });
    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("atomically reverses uncredited orphan observations and rewinds the checkpoint", async () => {
    const watcherKey = `${prefix}-reorg`;
    await store.getOrCreateCheckpoint({ chainId: 137, watcherKey, initialBlock: 100n });
    await observation(watcherKey, 102);
    const orphaned = await store.listActiveDeposits({ chainId: 137, watcherKey, fromBlock: 100n });
    const result = await store.recoverReorg({
      chainId: 137, watcherKey, expectedNextBlock: 101n, nextBlock: 100n,
      lastScannedBlockHash: hash(99), orphaned, reason: "integration reorg",
    });
    expect(result).toEqual({ reversed: 1, exceptions: 0 });
    const state = await pool.query("SELECT next_block::text FROM execution_chain_watcher_state WHERE chain_id=137 AND watcher_key=$1", [watcherKey]);
    const lifecycle = await pool.query("SELECT status FROM execution_deposit_lifecycle WHERE chain_id=137 AND transaction_hash=$1", [hash(102)]);
    expect(state.rows[0].next_block).toBe("100");
    expect(lifecycle.rows[0].status).toBe("reversed");
  });

  it("freezes rather than debiting an orphaned deposit that was already credited", async () => {
    const watcherKey = `${prefix}-credited-reorg`;
    const txHash = hash(103);
    const accountId = `${prefix}-account-103`;
    await store.getOrCreateCheckpoint({ chainId: 137, watcherKey, initialBlock: 100n });
    await observation(watcherKey, 103);
    const eventKey = `deposit:137:${txHash}:0`;
    await pool.query(
      "INSERT INTO execution_ledger_entries(account_id,event_key,entry_type,asset_address,amount_base_units,chain_id,transaction_hash,details) VALUES($1,$2,'deposit',$3,1000,137,$4,'{}'::jsonb)",
      [accountId,eventKey,token,txHash],
    );
    await pool.query(
      "UPDATE execution_deposit_lifecycle SET credited_event_key=$3 WHERE chain_id=137 AND watcher_key=$1 AND transaction_hash=$2",
      [watcherKey,txHash,eventKey],
    );
    await pool.query("UPDATE execution_control SET emergency_stop=FALSE WHERE id=1");
    const orphaned = await store.listActiveDeposits({ chainId: 137, watcherKey, fromBlock: 100n });
    const result = await store.recoverReorg({
      chainId: 137, watcherKey, expectedNextBlock: 101n, nextBlock: 100n,
      lastScannedBlockHash: hash(99), orphaned, reason: "integration credited reorg",
    });
    expect(result).toEqual({ reversed: 0, exceptions: 1 });
    const lifecycle = await pool.query("SELECT status FROM execution_deposit_lifecycle WHERE chain_id=137 AND transaction_hash=$1", [txHash]);
    const control = await pool.query("SELECT emergency_stop FROM execution_control WHERE id=1");
    const entries = await pool.query("SELECT amount_base_units::text FROM execution_ledger_entries WHERE event_key=$1", [eventKey]);
    expect(lifecycle.rows[0].status).toBe("reconciliation_required");
    expect(control.rows[0].emergency_stop).toBe(true);
    expect(entries.rows[0].amount_base_units).toBe("1000");
    const incident = await pool.query(
      "SELECT incident_type,status,account_id FROM execution_financial_incidents WHERE incident_key=$1",
      [`deposit-reorg:137:${txHash}:0`],
    );
    expect(incident.rows).toEqual([{ incident_type: "deposit_reorg_after_credit", status: "open", account_id: accountId }]);
    const restrictions = await pool.query(
      "SELECT account_id,restriction_type,status FROM execution_account_restrictions WHERE restriction_key = ANY($1::text[]) ORDER BY account_id",
      [[`deposit-reorg:137:${txHash}:0:account`, `deposit-reorg:137:${txHash}:0:sender`]],
    );
    expect(restrictions.rows).toHaveLength(2);
    expect(restrictions.rows.every((row) => row.restriction_type === "deposit_reorg" && row.status === "active")).toBe(true);

    const authorizationId = `${prefix}-authorization`;
    const intentId = `${prefix}-prepared-intent`;
    await pool.query(
      `INSERT INTO execution_authorizations
       (id,owner_address,chain_id,allowed_tokens,allowed_targets,maximum_sell_amount,expires_at,authorized_by)
       VALUES($1,$2,137,'[]'::jsonb,'[]'::jsonb,1000,NOW()+INTERVAL '1 hour','owner_wallet')`,
      [authorizationId,vault],
    );
    await pool.query(
      `INSERT INTO execution_transactions
       (id,idempotency_key,chain_id,wallet_address,sell_token,buy_token,side,sell_amount,quote,authorization_id,risk_checks,prepared_transaction,status)
       VALUES($1,$2,137,$3,$4,$5,'sell',1000,'{}'::jsonb,$6,'{}'::jsonb,'{}'::jsonb,'prepared')`,
      [intentId,`${prefix}-intent-key`,vault,token,sender,authorizationId],
    );
    const executionStore = new PostgresExecutionStore(pool);
    await expect(executionStore.leasePreparedIntent("integration-worker")).resolves.toBeNull();
    await expect(executionStore.reserveWithdrawal({
      id: `${prefix}-withdrawal`,
      accountId,
      token,
      recipient: vault,
      amount: "1",
      idempotencyKey: `${prefix}-withdrawal-key`,
    })).rejects.toThrow(/emergency stop/);

    // Account restrictions remain effective even if an operator mistakenly clears the
    // global stop; this test runs only against the explicitly configured disposable DB.
    await pool.query("INSERT INTO execution_reconciliation(wallet_address,token_address,chain_balance,ledger_balance,discrepancy,status) VALUES($1,$2,1000,1000,0,'matched')", [accountId,token]);
    await pool.query("UPDATE execution_control SET emergency_stop=FALSE WHERE id=1");
    await expect(executionStore.reserveWithdrawal({
      id: `${prefix}-withdrawal-restricted`,
      accountId,
      token,
      recipient: vault,
      amount: "1",
      idempotencyKey: `${prefix}-withdrawal-restricted-key`,
    })).rejects.toThrow(/account financial-integrity restriction/);
    await expect(executionStore.createOrGetIntent({
      id: `${prefix}-restricted-intent`,
      idempotencyKey: `${prefix}-restricted-intent-key`,
      walletAddress: sender,
      sellToken: token,
      buyToken: vault,
      sellAmount: "1",
      quote: {},
      authorizationId,
      riskChecks: {},
      preparedTransaction: {},
    })).rejects.toThrow(/financial-integrity restriction/);
    await pool.query("UPDATE execution_control SET emergency_stop=TRUE WHERE id=1");
  });
});
