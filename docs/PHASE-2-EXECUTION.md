# Phase 2 — constrained execution and accounting boundary

## Added on this branch

- 0x Swap API v2 firm-quote adapter for Polygon chain ID 137. It validates request/response chain, tokens, taker, exact sell amount, output/min-output, slippage, calldata shape, gas/value fields, target allowlist, and the documented `issues.allowance.spender` object. The spender is compared to configured policy. No configured provider credentials or reviewed production address registry are included.
- Exact token-amount helpers using BigInt/base-unit strings (`amounts.ts`) and focused unit tests.
- Read-only Polygon EVM client for chain verification, exact-call simulation/gas estimation, ERC-20 balance/allowance reads, receipt wait and gas calculation, hash reconciliation, and Transfer-log decoding. This client has no private key and no broadcast method.
- Execution pipeline skeleton: quote → risk/token/target check → authorization-scope check → durable idempotency reservation → exact transaction simulation. If a separately reviewed submit adapter is injected, it rechecks risk and authorization and re-simulates before submission; absent that adapter, live submission fails closed.
- PostgreSQL execution store primitives for idempotency reservation, leases, unknown/ambiguous submission records, receipt settlement and signed journal entries, idempotent deposit event keys, withdrawal reservations, wallet-to-ledger reconciliation, last reconciliation status and emergency-stop state. Migration 003 adds control, reconciliation, accounting, deposit-event and withdrawal reservation tables.
- Solidity `TreeBotExecutionVault` and Foundry tests. The vault restricts an executor by chain 137 and expiry, requires configured token/pair/target/spender policy, enforces per-token trade and daily spend caps, replay-protects intent IDs, starts paused, caps each ERC-20 approval to the exact input amount and clears it after the call, requires exact input balance decrease and at least the requested minimum output, and allows owner-only deposits/withdrawals. Owner withdrawals remain available while trading is paused.
- CI has a Foundry contract-test job for local EVM tests. The optional RPC suite is currently read-only and is not described as a live transaction integration test.

## Authorization design and security limits

The vault is a test-environment enforcement primitive, not permission to custody real funds. The owner authorizes and revokes a dedicated executor address on-chain; the executor cannot invoke withdrawals. The initial emergency stop is active. A call cannot attach native value, and the vault enforces input/output balance deltas even though it does not decode every 0x calldata selector and argument. Only owner-reviewed token, pair, target and spender lists should be configured.

**No production signing adapter is included.** The TypeScript authorization validator does not itself grant spending permission. The vault has not been independently audited, deployed to Polygon Amoy/mainnet, fuzzed by a security team, or reviewed for all aggregator/calldata/MEV/upgrade/incident threats. A production deployment with user funds is prohibited until independent contract review, a constrained executor-key provisioning/recovery design, and end-to-end testing are completed.

## Deposits, withdrawals and balances

- Contract-level owner deposit and withdrawal methods and database-side replay-safe deposit event accounting/withdrawal reservations are present as primitives.
- The direct database deposit-credit method now fails closed: caller-supplied receipt/confirmation fields cannot credit funds. The hash verifier enforces Polygon, direct ERC-20 `transfer`, matching receipt logs, configured token allowlist and confirmation depth, but it is not yet a durable block/log scanner and has no database-backed proof adapter or reorg reversal. Deposits remain disabled.
- The withdrawal reservation primitive is not a completed withdrawal settlement/recovery workflow. No authenticated API, token/recipient authorization binding, cap/gas policy, signer, broadcast/replacement tracking or receipt-driven terminal transition is wired. Do not represent it as a user-facing operational withdrawal workflow.
- Journal entries use exact signed base-unit amounts: deposit/buy credits are positive; sell/gas/fee debits are negative. The current aggregate journal is not yet a complete inventory/position/P&L subledger. Realized/unrealized P&L, committed position valuation, pending transfer/nonce handling, and full product balance API/UI are not complete.
- The 150 POL eligibility threshold is separate from allocated/deposited capital. Do not count a connected wallet’s observed funds as vault deposits, and reserve gas before any future eligibility/accounting check.

## Validation evidence and remaining gates

Foundry tests deploy local mock token/router contracts and exercise the vault on a local EVM with chain ID set to 137. These are local tests, not a Polygon testnet transaction or real 0x swap. The optional Polygon RPC suite only checks chain ID, ERC-20 balance and allowance; no testnet wallet/contract transaction is claimed. No credentialed 0x quote, on-chain deposit, actual withdrawal release, production deployment, profitability claim or independent security audit is claimed.

The current npm CI still has two blockers that must be resolved against the current head: Prettier formatting check reports formatting issues across baseline and new project files; the production audit passes with zero production vulnerabilities, but the full tree audit fails on the high-severity `braces` advisory in the development dependency chain `micromatch → fast-glob → @next/eslint-plugin-next → eslint-config-next`. Do not force a framework downgrade or hide the advisory with a blanket exception. The package repository currently has no committed lockfile, so dependency installation is not fully reproducible yet.

Official 0x references:
- https://docs.0x.org/docs/introduction/api-issues
- https://docs.0x.org/docs/introduction/quickstart/swap-tokens-with-0x-swap-api
- https://docs.0x.org/docs/core-concepts/contracts
