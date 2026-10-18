# TreeBot architecture

## Current runtime

- **Web:** Next.js App Router, React, TypeScript.
- **Wallet/network:** wagmi + viem using the Polygon PoS chain descriptor (chain ID 137).
- **Validation:** Zod at configuration boundaries and strict TypeScript.
- **Strategy core:** deterministic SMA, RSI, realized volatility and a cost-aware rule engine.
- **Execution in this stage:** isolated idempotent paper broker only.
- **Backtest:** historical bar replay that reports modeled returns, drawdown, wins/losses, fees, slippage, gas and buy-and-hold benchmark.
- **Observability:** local system-event view and no-store health endpoint.

## Trust boundaries

1. Browser wallet APIs are not trusted for authoritative accounting. Connected-wallet native balance is a read-only observation and requires a healthy network/RPC.
2. The strategy returns an explainable decision, not an executable authority. All external actions need independent server-side authorization and risk checks.
3. Paper fills are deterministic simulated records, labeled `simulated: true`, and cannot prove profitability.
4. This build intentionally has no live swap adapter, deposit transaction, vault contract, or withdrawal executor. UI controls cannot turn these on.
5. No backend hot wallet, seed phrase, private key, or arbitrary-signing endpoint is part of the architecture.

## Next production components

- Server-side market provider with schema validation, rate limiting, freshness windows, provider health and quote timestamp checks.
- Persistent database ledger and append-only audit log with unique chain transaction hashes and idempotency keys.
- Execution service using a verified Polygon-supported DEX aggregator/router, chain-specific contract allowlist, exact-input limits, bounded slippage, simulation and deadlines.
- User-authorized wallet execution or a narrowly scoped audited smart-account/vault design. No unrestricted backend custodian.
- Transaction watcher with replacement/nonce reconciliation and reorg-aware confirmation states.
- Durable job scheduler/worker with leases, heartbeat, bounded concurrency and emergency-stop checks immediately before submission.
- Reconciliation process comparing wallet balances, logs, fills, cost basis and ledger entries.
- Operational metrics, alerts, backups, and incident/recovery runbooks.

Do not enable mainnet live execution until these controls and independent security review are complete.
