# Phase 2.4C Deposit Scanner — Integration Contract

## Scope and safety

The Polygon deposit scanner is an orchestration boundary, not a production-enabled credit path by itself. Live deposit credit remains disabled until a PostgreSQL-backed implementation of `DepositScannerStore` is wired into the application and reviewed. Existing `PostgresExecutionStore.recordDepositEvent()` intentionally fails closed and must not be replaced by a caller-trusting credit operation.

## Required deployment wiring

A deployment must provide:

- A Polygon RPC implementation of `DepositRangeReader` that performs bounded `eth_getLogs` calls over the configured token contracts and vault recipient topic.
- A verified account-mapping source. The `accountForSender` callback must resolve an independently authenticated wallet/account binding; do not assume any arbitrary sender is enrolled.
- A PostgreSQL implementation of `DepositScannerStore` using `execution_chain_watcher_state`, `execution_deposit_lifecycle`, and `execution_ledger_entries`.
- A service process or scheduler with single-writer leases / compare-and-swap checkpoint updates.
- A finality policy suitable for the configured RPC and production risk model.

## Atomic store requirements

`commitScannedRange` must run in one database transaction:

1. Lock or compare-and-swap the row for `(chain_id, watcher_key)` and verify `expectedNextBlock`.
2. Verify observations are within the requested range and use valid configured tokens and vault address.
3. Upsert each event using `(chain_id, transaction_hash, log_index)` identity and reject conflicting immutable fields.
4. Record confirmed lifecycle state only after required finality and canonical block checks.
5. Insert ledger credit with a unique deterministic event key in the same transaction as lifecycle state.
6. Advance the checkpoint only after every observation is durably recorded.
7. Roll back lifecycle changes, credits, and checkpoint together on any error.

A duplicate event may be recognized without a second credit. Never delete financial journal history.

## Reorganization policy

Before crediting, use the configured confirmation/finality threshold and verify the block hash is canonical. On detected reorganization, stop advancing the affected checkpoint, re-read the affected canonical block range, and create compensating ledger entries for orphaned credits. If funds have already been allocated elsewhere, do not create a hidden negative balance: freeze affected spending and record `reconciliation_required` for operator resolution. Persist and test checkpoint rewind/replay behavior before enabling the scanner in production.

## Current limitation

The scanner module defines the typed scanning orchestration and a store contract. It is not yet a complete production integration: a concrete PostgreSQL `DepositScannerStore`, a configured Polygon reader, runtime worker wiring, full reorganization rewind/replay, and actual PostgreSQL integration tests are still required. The module and unit test do not prove real chain access or real deposits.

Keep deposits, withdrawals, and live trading disabled until all Phase 2 custody, accounting, and security gates are independently verified.
