# Phase 2 — Polygon DEX quote and execution boundary

## Verified external integration

The selected quote provider is 0x Swap API v2: `GET https://api.0x.org/swap/allowance-holder/quote`. Current official docs list Polygon among the supported EVM chains; calls require the `0x-api-key` and `0x-version: v2` headers, and a firm quote can include transaction calldata. See:

- https://docs.0x.org/api-reference/api-overview
- https://docs.0x.org/docs/introduction/quickstart/swap-tokens-with-0x-swap-api
- https://docs.0x.org/evm/0x-swap-api/introduction

This repository does not yet ship a production token allowlist or 0x credentials. A caller must explicitly pass reviewed token addresses, decimals and transaction-target addresses; there are no fabricated addresses/default trade pairs. An API key is required to retrieve live quotes. No successful live provider request is claimed by tests.

## Implemented boundary

- Server-side quote client requests chain ID 137 only, exact sell amount/taker, and bounded slippage.
- Strict validation for matching token pair/taker/amount, positive output, minimum output, transaction calldata/value/gas and explicit destination allowlist.
- A pure authorization scope check constrains owner, chain, token pair, destination, maximum base-unit sell amount, expiry and revocation. It is a validation primitive—not a deployed authorization grant or signing implementation.
- Durable SQL tables persist authorization metadata, idempotency keys, prepared transaction, quote/risk context, state, hash, nonce, settlement amounts, gas, errors and audit events. The unique idempotency key and transaction hash constraints help prevent duplicate records.
- A lifecycle state machine makes submission timeouts indeterminate and disallows naive retry.
- Live execution, deposits and withdrawals are still hard-disabled. The application does not sign or submit DEX transactions and this migration only adds metadata tables; it cannot authorize users or hold/deploy funds by itself.

## Custody choice and why automation is not enabled

The current app has a read-only injected wallet connection. Browser wallet signatures require a foreground user interaction and are unsuitable for unattended trading. A server-held private key would introduce unrestricted custody, contrary to the security requirements. The next intended direction is a narrowly scoped smart account or audited vault, but that contract/account policy has not been implemented, deployed or independently audited. Therefore no autonomous mainnet execution is claimed. Do not deposit funds.

## Explicit blockers before testnet or mainnet transaction submission

- Resolve the 0x AllowanceHolder allowance spender and any required approvals using the current provider schema. Never approve the returned router or spender without validating it against an independently maintained allowlist.
- Add viem simulation for the exact calldata, compare all decoded selector/arguments against the intended swap, validate deadline and token approvals, and re-check the durable emergency stop just before send.
- Implement a trusted transaction watcher that queries receipt, nonce, balances and Transfer logs and waits for confirmations/reorg safety; use actual receipt amounts and gas rather than quote estimates.
- Add durable multi-worker leasing/atomic create-or-get transaction service with transaction state transitions and concurrent request tests.
- Build a limited smart account/vault with explicit spend/token/target/rate limits, pause, recovery and withdrawal behavior; fuzz/invariant tests and external audit before deploying.
- Implement actual wallet-assigned funding and user-withdrawal workflows only after custody semantics exist.
- Configure and verify Polygon RPC, 0x API key, PostgreSQL migrations, worker supervision, backup/alerts. None of these environment-bound production checks is claimed in this PR.

## Fund management status

A/B/C real fund-management workflows are not implemented. The current UI's connected wallet read remains informational only. The existing 150 POL + gas-reserve threshold is an eligibility check on connected native balance; it is not deposited capital and does not unlock live trading. Portfolio balance reconciliation against real tokens/contracts remains outstanding.

## Test posture

Unit tests use constructed payload fixtures to exercise the validator and authorization state machine. These are not real 0x quotes, not Polygon RPC integration, not testnet results, and not evidence of profitability. Mainnet live mode, deposits and withdrawals remain disabled by code and configuration.
