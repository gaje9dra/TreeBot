import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { Address, Hash, Hex } from "viem";
import { PostgresDepositScannerStore, PostgresExecutionStore } from "../postgres";
import { PolygonDepositScanner, type DepositRangeReader } from "../deposit-scanner";
import { verifyWithdrawalSettlement, type WithdrawalChainReader } from "../withdrawal-verifier";

const enabled = process.env.TREEBOT_RUN_POSTGRES_INTEGRATION === "true";
const describePostgres = enabled ? describe : describe.skip;
const prefix = `phase24c-${process.pid}-${Date.now()}`;
const vault = "0x0000000000000000000000000000000000000010" as Address;
const token = "0x0000000000000000000000000000000000000020" as Address;
const sender = "0x0000000000000000000000000000000000000030" as Address;
const hashSeed = BigInt(Date.now()) * 1_000_000n + BigInt(process.pid);
const hash = (n: number) => `0x${(hashSeed + BigInt(n)).toString(16).padStart(64, "0")}` as Hash;
const integrationWallet = ("0x" + (hashSeed + 6000n).toString(16).padStart(40, "0").slice(-40)) as Address;

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
    await pool.query("UPDATE execution_control SET emergency_stop=TRUE WHERE id=1");
    await pool.query("DELETE FROM execution_withdrawal_audit_events WHERE withdrawal_id LIKE $1", [`${prefix}%`]);
    await pool.query("DELETE FROM execution_withdrawal_reservations WHERE id LIKE $1", [`${prefix}%`]);
    await pool.query("DELETE FROM execution_account_restrictions WHERE account_id LIKE $1 OR evidence->>'accountId' LIKE $1", [`${prefix}%`]);
    await pool.query("DELETE FROM execution_financial_incidents WHERE account_id LIKE $1 OR details->>'accountId' LIKE $1", [`${prefix}%`]);
    await pool.query("DELETE FROM execution_reconciliation WHERE wallet_address LIKE $1 OR LOWER(wallet_address) IN (LOWER($2),LOWER($3))", [`${prefix}%`, "0x0000000000000000000000000000000000000040", integrationWallet]);
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
      sourceAddress: sender,
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
      sourceAddress: sender,
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
    await pool.query("UPDATE execution_transactions SET status='failed' WHERE id=$1", [intentId]);
    await pool.query(
      `INSERT INTO execution_transactions
       (id,idempotency_key,chain_id,wallet_address,sell_token,buy_token,side,sell_amount,quote,authorization_id,risk_checks,prepared_transaction,status)
       VALUES($1,$2,137,$3,$4,$5,'sell',1,'{}'::jsonb,$6,'{}'::jsonb,'{}'::jsonb,'prepared')`,
      [`${prefix}-preexisting-restricted-intent`, `${prefix}-preexisting-restricted-key`, sender, token, vault, authorizationId],
    );
    await expect(executionStore.leasePreparedIntent("restricted-worker")).resolves.toBeNull();
    await pool.query("UPDATE execution_control SET emergency_stop=TRUE WHERE id=1");
  });

  it("credits only runtime-issued matching proof and remains idempotent under concurrent workers", async () => {
    const watcherKey = prefix + "-proof-credit";
    const accountId = prefix + "-proof-account";
    const txHash = hash(701);
    const proofSender = "0x0000000000000000000000000000000000000040" as Address;
    const blockHash = hash(700);
    await store.getOrCreateCheckpoint({ chainId: 137, watcherKey, initialBlock: 700n });
    const event = {
      chainId: 137 as const, transactionHash: txHash, logIndex: 1, accountId,
      assetAddress: token, senderAddress: proofSender, vaultAddress: vault, amountBaseUnits: "1234567",
      blockNumber: "700", blockHash, confirmations: 64, requiredConfirmations: 64,
    };
    const forged = { ...event, proof: {
      chainId: 137, transactionHash: txHash, receiptTransactionHash: txHash, receiptStatus: "success",
      receiptBlockNumber: "700", receiptBlockHash: blockHash, logIndex: 1, accountId, tokenAddress: token,
      senderAddress: proofSender, recipientAddress: vault, amountBaseUnits: "1234567",
      blockNumber: "700", blockHash, tokenDecimals: 6,
    } as unknown as import("../deposit-proof").VerifiedDepositProof };
    await expect(store.commitScannedRange({
      chainId: 137, watcherKey, expectedNextBlock: 700n, nextBlock: 701n,
      lastScannedBlockHash: blockHash, observations: [forged],
    })).rejects.toThrow(/untrusted/);
    const stateAfterForgery = await pool.query(
      "SELECT next_block::text FROM execution_chain_watcher_state WHERE chain_id=137 AND watcher_key=$1", [watcherKey],
    );
    expect(stateAfterForgery.rows[0].next_block).toBe("700");
    const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;
    const addressTopic = (address: string): Hex => ("0x" + address.slice(2).toLowerCase().padStart(64, "0")) as Hex;
    const amountData = ("0x" + BigInt(event.amountBaseUnits).toString(16).padStart(64, "0")) as Hex;
    const fakeChain = {
      getChainId: async () => 137,
      getBlockNumber: async () => 800n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
        number: blockNumber,
        hash: blockNumber === 700n ? blockHash : hash(Number(blockNumber)),
        parentHash: hash(Number(blockNumber - 1n)),
      }),
      getTransactionReceipt: async () => ({
        transactionHash: txHash, status: "success" as const, blockNumber: 700n, blockHash,
        logs: [{
          address: token, logIndex: 1, data: amountData,
          topics: [transferTopic, addressTopic(proofSender), addressTopic(vault)],
        }],
      }),
      getTransaction: async () => ({ hash: txHash, from: proofSender, to: token, input: "0xa9059cbb" as Hex }),
      getLogs: async () => [{
        transactionHash: txHash, blockNumber: 700n, blockHash, logIndex: 1,
        tokenAddress: token, senderAddress: proofSender, recipientAddress: vault, amount: BigInt(event.amountBaseUnits),
      }],
    } as unknown as DepositRangeReader;
    const scanner = new PolygonDepositScanner(fakeChain, store, {
      watcherKey, startBlock: 700n, vaultAddress: vault, supportedTokenAddresses: [token],
      creditingEnabled: true, tokenDecimalsByAddress: { [token.toLowerCase()]: 6 }, confirmations: 64, maxBlockRange: 100,
      accountForSender: async () => accountId,
    });
    const results = await Promise.allSettled([scanner.scanOnce(), scanner.scanOnce()]);
    const rejectionMessages = results.filter((result) => result.status === "rejected").map((result) => String(result.reason));
    expect(results.filter((result) => result.status === "fulfilled"), rejectionMessages.join("\n")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const ledger = await pool.query(
      "SELECT event_key,amount_base_units::text,details->>'tokenDecimals' AS decimals FROM execution_ledger_entries WHERE account_id=$1 AND entry_type='deposit'",
      [accountId],
    );
    expect(ledger.rows).toEqual([{ event_key: "deposit:137:" + txHash.toLowerCase() + ":1", amount_base_units: "1234567", decimals: "6" }]);
    const deposit = await pool.query(
      "SELECT token_decimals,LOWER(block_hash) AS block_hash,receipt_status FROM execution_deposit_events WHERE chain_id=137 AND transaction_hash=$1 AND log_index=1",
      [txHash],
    );
    expect(deposit.rows).toEqual([{ token_decimals: 6, block_hash: blockHash, receipt_status: "success" }]);
    const lifecycle = await pool.query(
      "SELECT credited_event_key,status FROM execution_deposit_lifecycle WHERE chain_id=137 AND transaction_hash=$1 AND log_index=1",
      [txHash],
    );
    expect(lifecycle.rows).toEqual([{ credited_event_key: "deposit:137:" + txHash.toLowerCase() + ":1", status: "confirmed" }]);
  });


  it("serializes competing withdrawals and settles only from verified canonical receipts", async () => {
    const accountId = prefix + "-withdrawal-settlement-account";
    const source = "0x0000000000000000000000000000000000000040" as Address;
    const recipient = "0x0000000000000000000000000000000000000050" as Address;
    const executionStore = new PostgresExecutionStore(pool);
    await pool.query(
      "INSERT INTO execution_ledger_entries(account_id,event_key,entry_type,asset_address,amount_base_units,chain_id,transaction_hash,details) VALUES($1,$2,'deposit',$3,1000,137,$4,'{}'::jsonb)",
      [accountId, prefix + "-withdrawal-funding", token, hash(800)],
    );
    await pool.query(
      "INSERT INTO execution_reconciliation(wallet_address,token_address,chain_balance,ledger_balance,discrepancy,status) VALUES($1,$2,1000,1000,0,'matched')",
      [source, token],
    );
    await pool.query("UPDATE execution_control SET emergency_stop=FALSE WHERE id=1");
    const ids = [prefix + "-withdrawal-race-a", prefix + "-withdrawal-race-b"];
    const attempts = await Promise.allSettled(ids.map((id) => executionStore.reserveWithdrawal({
      id, accountId, sourceAddress: source, token, recipient, amount: "700", idempotencyKey: id + "-key",
    })));
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winnerIndex = attempts.findIndex((result) => result.status === "fulfilled");
    const winnerId = ids[winnerIndex]!;
    await expect(executionStore.reserveWithdrawal({
      id: winnerId, accountId, sourceAddress: source, token, recipient, amount: "700", idempotencyKey: winnerId + "-key",
    })).resolves.toEqual({ reserved: false });

    await executionStore.beginWithdrawalSubmission(winnerId);
    const successHash = hash(802);
    await executionStore.recordWithdrawalSubmission({ id: winnerId, transactionHash: successHash, nonce: 21 });
    await expect(executionStore.recordWithdrawalSubmission({ id: winnerId, transactionHash: successHash, nonce: 21 })).resolves.toBeUndefined();

    const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;
    const addressTopic = (address: Address): Hex => ("0x" + address.slice(2).toLowerCase().padStart(64, "0")) as Hex;
    const chainFor = (txHash: Hash, blockNumber: number, status: "success" | "reverted", amount: string, gasUsed: bigint, gasPrice: bigint, nonce: number) => ({
      getChainId: async () => 137,
      getTransactionReceipt: async () => ({
        transactionHash: txHash, status, blockNumber: BigInt(blockNumber), blockHash: hash(blockNumber),
        gasUsed, effectiveGasPrice: gasPrice,
        logs: status === "success" ? [{
          address: token,
          data: ("0x" + BigInt(amount).toString(16).padStart(64, "0")) as Hex,
          topics: [transferTopic, addressTopic(source), addressTopic(recipient)],
          logIndex: 9,
        }] : [],
      }),
      getTransaction: async () => ({ hash: txHash, from: source, to: token, nonce }),
      getBlockNumber: async () => 900n,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
        number: blockNumber, hash: hash(Number(blockNumber)), parentHash: hash(Number(blockNumber - 1n)),
      }),
    }) as unknown as WithdrawalChainReader;
    const successProof = await verifyWithdrawalSettlement(
      chainFor(successHash, 802, "success", "700", 100_000n, 30n, 21),
      { withdrawalId: winnerId, transactionHash: successHash, sourceAddress: source, tokenAddress: token,
        recipientAddress: recipient, amountBaseUnits: "700", requiredConfirmations: 64 },
    );
    await expect(executionStore.settleWithdrawal(successProof)).resolves.toEqual({ settled: true, status: "confirmed" });
    await expect(executionStore.settleWithdrawal(successProof)).resolves.toEqual({ settled: false, status: "confirmed" });
    await expect(executionStore.getLedgerBalance(accountId, token)).resolves.toBe("300");

    const unknownId = prefix + "-withdrawal-unknown";
    await expect(executionStore.reserveWithdrawal({
      id: unknownId, accountId, sourceAddress: source, token, recipient, amount: "200", idempotencyKey: unknownId + "-key",
    })).resolves.toEqual({ reserved: true });
    await executionStore.beginWithdrawalSubmission(unknownId);
    await executionStore.recordWithdrawalUnknown({ id: unknownId, reason: "RPC timed out after submission may have started" });
    const unknown = await pool.query("SELECT status FROM execution_withdrawal_reservations WHERE id=$1", [unknownId]);
    expect(unknown.rows[0].status).toBe("unknown");
    await expect(executionStore.cancelWithdrawalBeforeSubmission({
      id: unknownId, actorId: "integration-operator", reason: "attempted unsafe cancellation",
    })).rejects.toThrow(/may have been submitted/);
    await expect(executionStore.beginWithdrawalSubmission(unknownId)).rejects.toThrow(/Only an untouched reserved withdrawal/);

    const revertedHash = hash(803);
    const revertedProof = await verifyWithdrawalSettlement(
      chainFor(revertedHash, 803, "reverted", "200", 80_000n, 20n, 22),
      { withdrawalId: unknownId, transactionHash: revertedHash, sourceAddress: source, tokenAddress: token,
        recipientAddress: recipient, amountBaseUnits: "200", requiredConfirmations: 64 },
    );
    await expect(executionStore.settleWithdrawal(revertedProof)).resolves.toEqual({ settled: true, status: "reverted" });
    await expect(executionStore.getLedgerBalance(accountId, token)).resolves.toBe("300");
    const terminal = await pool.query("SELECT status,settlement_actual_amount::text,settlement_gas_wei::text FROM execution_withdrawal_reservations WHERE id=$1", [unknownId]);
    expect(terminal.rows[0]).toEqual({ status: "reverted", settlement_actual_amount: "0", settlement_gas_wei: "1600000" });
    const gasEntries = await pool.query(
      "SELECT amount_base_units::text FROM execution_ledger_entries WHERE account_id=$1 AND entry_type='gas' AND transaction_hash IN ($2,$3) ORDER BY transaction_hash",
      [accountId, successHash, revertedHash],
    );
    expect(gasEntries.rows.map((row) => row.amount_base_units)).toEqual(["-3000000", "-1600000"]);
    await pool.query("UPDATE execution_control SET emergency_stop=TRUE WHERE id=1");
  });


  it("prevents a trade and withdrawal from reserving the same balance concurrently", async () => {
    const wallet = integrationWallet;
    const buyToken = "0x0000000000000000000000000000000000000080" as Address;
    const recipient = "0x0000000000000000000000000000000000000090" as Address;
    const executionStore = new PostgresExecutionStore(pool);
    await pool.query(
      "INSERT INTO execution_ledger_entries(account_id,event_key,entry_type,asset_address,amount_base_units,chain_id,transaction_hash,details) VALUES($1,$2,'deposit',$3,1000,137,$4,'{}'::jsonb)",
      [wallet, prefix + "-trade-withdrawal-funding", token, hash(910)],
    );
    await pool.query(
      "INSERT INTO execution_reconciliation(wallet_address,token_address,chain_balance,ledger_balance,discrepancy,status) VALUES($1,$2,1000,1000,0,'matched')",
      [wallet, token],
    );
    await pool.query("UPDATE execution_control SET emergency_stop=FALSE WHERE id=1");
    const trade = executionStore.createOrGetIntent({
      id: prefix + "-trade-race",
      idempotencyKey: prefix + "-trade-race-key",
      walletAddress: wallet,
      sellToken: token,
      buyToken,
      sellAmount: "700",
      quote: { provider: "test", sellAmount: "700" },
      authorizationId: prefix + "-trade-auth",
      riskChecks: { passed: true },
      preparedTransaction: { to: recipient, data: "0x", value: "0" },
    });
    const withdrawal = executionStore.reserveWithdrawal({
      id: prefix + "-withdrawal-race",
      accountId: wallet,
      sourceAddress: wallet,
      token,
      recipient,
      amount: "700",
      idempotencyKey: prefix + "-withdrawal-race-key",
    });
    const results = await Promise.allSettled([trade, withdrawal]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const heldTrades = await pool.query(
      "SELECT COALESCE(SUM(sell_amount),0)::text AS amount FROM execution_transactions WHERE wallet_address=$1 AND sell_token=$2 AND status IN ('prepared','signed','submitted','pending','unknown','replaced')",
      [wallet, token],
    );
    const heldWithdrawals = await pool.query(
      "SELECT COALESCE(SUM(amount_base_units),0)::text AS amount FROM execution_withdrawal_reservations WHERE account_id=$1 AND asset_address=$2 AND status IN ('reserved','submitting','submitted','unknown')",
      [wallet, token],
    );
    expect(BigInt(heldTrades.rows[0].amount) + BigInt(heldWithdrawals.rows[0].amount)).toBe(700n);
    await pool.query("UPDATE execution_control SET emergency_stop=TRUE WHERE id=1");
  });

});
