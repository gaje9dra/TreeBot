# Security model and release gates

## Safe defaults

- Chain ID 137 only.
- Paper trading is the default mode.
- `TREEBOT_LIVE_TRADING_ENABLED=false` and `TREEBOT_DEPOSITS_ENABLED=false`.
- The config parser rejects deposit enablement. Live execution has no implemented adapter and therefore cannot be enabled merely through an environment variable.
- No seed phrases or private keys are collected or stored.
- Wallet connect is not transaction authorization.
- Token, router, chain, allowance, spending, slippage and deadline checks are mandatory before any future swap integration.

## Dependency audit posture

- CI runs `npm audit --omit=dev --audit-level=high` as a hard production-dependency gate.
- CI also audits the full dependency tree. One narrowly scoped temporary exception is retained for `braces` / GHSA-vfj7-8cjw-p6xm, a high-severity advisory with no patched upstream release as of 2026-10-18. It is pulled by development lint tooling, is not a direct dependency, and is not present in the production dependency audit.
- The exception is identity-specific: any other high/critical advisory fails CI. The finding is printed in CI logs and must be removed once a fixed upstream release exists. Do not broaden or renew it automatically.

## Required before real funds

1. Review the exact DEX/aggregator integration docs and verify Polygon deployment addresses from primary sources.
2. Establish a threat model covering malicious tokens, honeypots, MEV/sandwich risk, stale or manipulated quotes, route changes, RPC compromise, reorgs, nonce collisions, transaction replacement, compromised browser dependencies, denial of service and compromised owner accounts.
3. Implement least-privilege user-authorized transaction submission; no unrestricted backend custodian.
4. If a vault is later needed, separately develop and test a contract with access control, safe token interactions, reentrancy defenses where applicable, withdrawal guarantees, pause semantics, events, invariant tests and a recovery plan.
5. Obtain independent smart-contract review/audit before any contract handles real funds.
6. Add durable server-side authorization and risk checks, atomic idempotency, a database audit trail, replay protection, and transaction reconciliation.
7. Test with mocks, Polygon Amoy/testnet and a local fork. Never use user funds for testing.
8. Require an explicit owner-controlled live-enable process after deployment and health checks. Keep a fast global stop for new trades.
9. Document custody, permissions, contract addresses, withdrawal restrictions, audit report, recovery process and incident contacts.

## Operational rules

- Missing/stale market data, RPC uncertainty, invalid quotes, unexpected wallet network, exceeded loss limits, or ambiguous transaction status must stop new trades.
- Never blindly resubmit a transaction while nonce/status is unknown.
- Stop Trading means stop new entries. It must not implicitly liquidate open assets.
- Display estimated and confirmed values separately. Reconcile settled fills from chain data.
- Rate-limit public endpoints and avoid returning secrets in health checks or logs.

## Current known limitations

Real deposits, withdrawals and swaps are not implemented. No smart contract has been deployed or audited. No profitability claim or live performance result is available from the paper modules.
