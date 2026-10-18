# Phase 2.3 — execution and fund-management status

Date: 2026-10-18

## Repository state

- Phase 2 branch: `feat/treebot-phase-2-execution`
- Branch head before this status record: `b0cc30e01d80a70718782b8486affe7f26582fc3`
- GitHub reports PR #4 as **merged** at `132a25c70ef11f873ae0b604c07b0b04a91c2711`, despite earlier draft/unmerged status notes. This status document does not attempt to rewrite merge history.
- Latest validated pull-request workflow for the pre-existing branch head: [run 228](https://github.com/gaje9dra/TreeBot/actions/runs/39113427577). All three jobs completed successfully.

## Existing verified CI scope

The latest successful workflow executed:
- Prettier format check
- ESLint
- TypeScript typecheck
- Vitest unit/boundary test command
- Gated Polygon integration-test command
- Next.js production build
- Production and full dependency audit gate
- Foundry contract formatting and local-EVM tests

The integration step passed as a *gated command*. The available evidence does not demonstrate a credentialed Polygon testnet execution, deposit, withdrawal, transaction receipt, or reorganization test. The full dependency audit gate retains the explicitly documented upstream `braces` GHSA-vfj7-8cjw-p6xm development dependency exception; this must not be described as a zero-finding full dependency audit.

## Implemented in the repository, but not sufficient for production custody

- Polygon-chain restricted read/simulation client and gas estimation.
- 0x firm-quote parser with token/transaction-target/allowance-target checks.
- Execution authorization validation for owner, chain ID 137, token and target allowlists, expiry/revocation, and per-trade/daily amounts.
- Durable execution intent/idempotency primitives and a submission adapter interface with no generic backend signer.
- Read-only trusted deposit verification for direct ERC-20 transfers, including receipt status, token contract, recipient, Transfer log, and confirmation depth.
- PostgreSQL journal/reconciliation/reservation primitives.
- Restricted `TreeBotExecutionVault` and local-EVM tests.

These features are not an assertion that funds can safely move. In particular, the repository does not yet evidence semantic decoding for every supported swap calldata route, end-to-end signer/submission/receipt recovery, a long-running reorg-aware deposit watcher, complete withdrawal release/settlement, or authoritative positions and valuation.

## Critical blockers

1. No independently audited and wired smart-account signer/submission adapter. Do not add an unrestricted server signer.
2. No demonstrated full semantic validation of 0x transaction calldata against the intended sell/buy assets, recipient, spender, exact input, and minimum output for every allowed selector/route.
3. No actual Polygon testnet/fork evidence for quote-to-broadcast-to-receipt settlement, ambiguous submission recovery, replacement, restart, timeout, or reorg handling.
4. Deposit processing currently verifies an event before a store callback but lacks a complete durable watch/reorg reversal lifecycle.
5. Withdrawal reservation primitives exist, but authorized on-chain release, transaction tracking, success settlement, definitive-failure release, and ambiguous-submission recovery are incomplete.
6. No complete unified portfolio accounting of confirmed wallet/vault balances, reservations, pending movement, positions/cost basis, fees/gas/slippage, realized/unrealized P&L, valuation timestamp/source, and reconciliation.
7. No executed PostgreSQL integration/concurrency/restart/migration test evidence was surfaced in the workflow run.
8. The 150 POL criterion appears in the research/paper dashboard as wallet readiness plus a 2 POL gas reserve, but no production-authoritative cross-wallet/vault capital policy and execution-time enforcement is verified.
9. No independent smart-contract/custody security review or deployment evidence.
10. The latest dependency workflow passes only with a narrow visible exception for GHSA-vfj7-8cjw-p6xm in development tooling.

## Safe operating mode

Paper trading remains the supported mode. Keep live trading, real deposits, and real withdrawals disabled. Do not claim profitability from the 150 POL threshold. The threshold is eligibility/risk policy only, not a return guarantee.

## Merge / phase decision

**Phase 2 is not complete.** The pre-existing PR #4 is already merged according to GitHub, so its “keep PR open/unmerged” condition cannot be preserved retroactively. Do not treat the merge or green CI as approval for live execution. No Phase 3 work is authorized by this status record.
