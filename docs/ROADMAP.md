# TreeBot staged roadmap

## Stage 1 — Foundation
- [x] Initialize documented repository.
- [x] Add TypeScript/Next.js structure, lint/typecheck/test/build scripts and CI workflow.
- [x] Add security headers and environment validation.

## Stage 2 — Wallet / Polygon
- [x] Polygon chain ID validation, EVM address validation, native balance eligibility calculation.
- [x] Wallet connection and chain switch UI.
- [ ] Add supported ERC-20 portfolio balances and RPC health probes with production timeout/alerting.
- [ ] Test wallet connectors with configured WalletConnect project credentials.

## Stage 3 — Market data and decision engine
- [x] Typed market schema, candle validation, SMA, RSI and volatility metrics.
- [x] Explainable decision result and conservative rejection rules for stale data, costs, liquidity, exit availability and portfolio limits.
- [x] Add configurable HTTPS normalized market-data provider adapter, freshness checks, schema validation, and dashboard snapshot fetch.
- [ ] Select a concrete market-data provider and configure production credentials; independently verify DEX quotes against primary documentation.
- [ ] Add integration tests for quote freshness, token allowlists and provider outages.

## Stage 4 — Backtesting and paper trading
- [x] Idempotent simulation broker and bar-based backtest with modeled fees, slippage and gas.
- [ ] Add sourced historical datasets, walk-forward and out-of-sample reports, multiple market regimes and more realistic fill/failed-trade models.
- [x] Add a separate supervised-process paper worker, PostgreSQL ledger schema, idempotent decision/trade records, CLI enable/disable/emergency-stop controls, and simulated P&L accounting.
- [ ] Configure and operate the worker against a production PostgreSQL instance; add external monitoring/alerts and verify database recovery.

## Stage 5 — Ledger, risk and monitoring
- [x] Typed risk limits, loss/exposure gates and hard-disabled live execution path.
- [x] Health endpoint and operator dashboard labels for simulated/local events.
- [x] Add PostgreSQL-backed paper decisions/trades, per-pair simulated portfolio state, and a database-locked paper emergency stop.
- [ ] Add external monitoring/alerts, backups, and recovery drills; real transaction reconciliation remains a Stage 6 blocker.

## Stage 6 — Transaction execution and fund-management
- [ ] Select and verify a specific DEX aggregator/router supported on Polygon from current primary documentation.
- [ ] Implement transaction building, user authorization, quote revalidation, simulation, bounded slippage/deadline, nonce tracking and reorg-aware settlement.
- [ ] Implement verified deposit/withdraw only after custody model and contract review; keep all deposits disabled until then.
- [ ] Implement atomic idempotent transaction ledger and ERC-20 balance reconciliation.

## Stage 7 — Security / production
- [ ] Threat model review, dependency remediation and external security review.
- [ ] Testnet/local-fork transactions and operational recovery drills.
- [ ] Configure real provider secrets, monitoring, backup, deployment and alert channels.
- [ ] Owner explicitly authorizes live mode after all release gates pass.

## Release blockers

The current implementation is an initial build, not a production autonomous trading service. Live execution and deposits are deliberately unavailable. Provider credentials, persistence, worker orchestration, contract security review and production deployment access have not been supplied or verified.
