# Phase 2.4C Deposit Scanner — Integration Contract

## Scope and safety

The scanner records observed Polygon ERC-20 transfers and durable lifecycle state. It does **not** create spendable credits. PostgresExecutionStore.recordDepositEvent() intentionally fails closed, and the scanner's PostgreSQL store returns credited: 0 for every range. Deposits, withdrawals, and live trading must remain disabled.

## Implemented and verified

- Polygon RPC reader scans bounded Transfer log ranges for configured token contracts and vault recipient.
- Scanner matches each candidate to the exact receipt log index, token address, Transfer topic, sender topic, recipient topic, amount data, transaction hash, receipt block number, and receipt block hash.
- The trusted transaction watcher also verifies that the receipt block hash matches the current canonical block.
- PostgreSQL scanner observations and checkpoint advancement share a serializable transaction with checkpoint compare-and-swap and unique (chain_id, transaction_hash, log_index) event identity.
- Reorg lifecycle changes and checkpoint rewind share one serializable transaction. Uncredited orphan observations are marked reversed. If an orphan is already linked to a ledger credit, the store marks it reconciliation_required, writes an audit event, enables the emergency stop, blocks withdrawal reservations and prepared-intent leases, and does **not** issue an aggregate-balance-based debit.
- GitHub Actions starts a disposable PostgreSQL 16 service, applies migrations 001–005, and runs PostgreSQL integration tests for persistence/no-credit behavior, concurrent checkpoint commits, atomic reorg rewind, credited-orphan fail-closed behavior, and transaction rollback.

## Still blocked — do not enable financial operations

1. **Trusted durable credit path:** recordDepositEvent() is still disabled. A successful receipt observation is not yet a spendable balance credit.
2. **Allocation-aware recovery:** the system does not yet maintain source-lot provenance through reservations, withdrawals, trades, fees, and cross-asset proceeds. A credited orphan therefore freezes for explicit reconciliation rather than being automatically reversed. Do not replace this with an aggregate-balance check.
3. **Runtime wiring:** the scanner is not wired to a production worker/scheduler with authenticated account mapping, deployment-configured token/vault allowlists, single-writer coordination, and operational alerting.
4. **Operational recovery proof:** CI exercises database transactions, concurrency, and restart-safe state changes, but it does not establish a production RPC's reorg characteristics or validate live account mappings.

## Requirements before completion

- Define and test per-deposit allocation/provenance across every ledger use before any automatic compensating debit is allowed.
- Implement a trusted server-side credit boundary that persists verified receipt block hash, exact log identity, finality evidence, and an idempotent ledger entry in one PostgreSQL transaction.
- Wire the scanner to a controlled runtime only after configuration and account mapping are independently authenticated.
- Keep deposits, withdrawals, and live trading disabled until the remaining gates are implemented, independently reviewed, and verified on the exact final commit.


## Release-gate clarification — 2026-10-18

The current scanner's PostgreSQL integration coverage proves atomic checkpoint/event persistence, concurrent checkpoint compare-and-swap, rollback, and fail-closed handling of a previously credited event that becomes orphaned. It does **not** prove that a verified deposit can be credited spendably, because the store's `recordDepositEvent` boundary remains intentionally disabled.

Do not remove this disabled boundary by passing scanner observations directly into the ledger. Before enabling credits, introduce an unforgeable server-side proof object produced only by the trusted watcher, validate receipt/block/log identity and finality within the credit transaction, enforce unique `(chain_id, transaction_hash, log_index)` identity, and add allocation provenance before compensating any previously credited orphan. The production watcher also needs supervised runtime wiring, authenticated sender-to-account mapping, alerting, and a tested recovery drill.

Until those controls and independent review are complete, keep deposits, withdrawals, and live execution disabled.
