# TreeBot Deposit Worker Operations

## Current release state

The deposit worker is implemented but **not activatable in this build**. `DEPOSIT_FEATURE_AVAILABLE` remains `false`, and the worker exits before opening a database connection unless `TREEBOT_DEPOSITS_ENABLED=true`; if that flag is set in this build, the hard release gate rejects startup. Do not change that constant or enable production deposits until the independent security review, custody review, Polygon testnet/fork verification, alert test, and operator approval are complete.

The worker does not sign transactions or initiate withdrawals. It scans only Polygon PoS (chain ID 137), requires two distinct HTTPS RPC providers with matching heads and finalized block hashes, checks the configured token allowlist and token decimals, uses durable PostgreSQL checkpoints, and preserves unmapped sender observations as non-creditable records for operations alerts.

## Required environment configuration after approval

Set these values through the deployment secret manager or a root-readable environment file, not in source control:

- `DATABASE_URL`
- `POLYGON_RPC_URL` and `POLYGON_RPC_FALLBACK_URL` (distinct HTTPS endpoints)
- `TREEBOT_DEPOSIT_WATCHER_KEY` (stable, unique checkpoint/health key)
- `TREEBOT_DEPOSIT_VAULT_ADDRESS`
- `TREEBOT_DEPOSIT_TOKENS_JSON` (JSON array of approved ERC-20 addresses)
- `TREEBOT_DEPOSIT_TOKEN_DECIMALS_JSON` (JSON object mapping every approved token address to its verified decimals)
- `TREEBOT_DEPOSIT_SENDER_MAP_JSON` (JSON object mapping authorized sender addresses to account IDs)
- `TREEBOT_DEPOSIT_START_BLOCK` (explicit non-negative block; never guess this on an existing deployment)
- `TREEBOT_DEPOSIT_CONFIRMATIONS` (default 64)
- `TREEBOT_DEPOSIT_MAX_BLOCK_RANGE` (default 100; maximum 2,000)
- `TREEBOT_DEPOSIT_POLL_INTERVAL_MS` (default 10,000; allowed 1,000–60,000)
- `TREEBOT_DEPOSIT_STALL_AFTER_MS` (default 120,000)
- `TREEBOT_DEPOSIT_ALERT_WEBHOOK` (HTTPS endpoint)
- `TREEBOT_DEPOSITS_OPERATOR_APPROVED=true`
- `TREEBOT_DEPOSITS_SECURITY_REVIEWED=true`
- `TREEBOT_DEPOSITS_NETWORK_VERIFIED=true`
- `TREEBOT_DEPOSITS_ENABLED=true`

The environment flags are attestations, not substitutes for review. This repository build-level gate remains disabled until an approved release commit explicitly changes it.

## Migration and local check

Run migrations before deploying the worker:

```bash
npm run ledger:migrate:all
```

With deposits disabled (the default), the worker command should log that it is disabled and exit without scanning or opening a database connection:

```bash
npm run worker:deposits
```

The current build is expected to reject startup if `TREEBOT_DEPOSITS_ENABLED=true`. Do not interpret a successful build or a passing local PostgreSQL test as permission to enable deposits.

## Supervision

Run the worker as a dedicated, non-root service with access only to its database and RPC/webhook configuration. A systemd service should use `Restart=on-failure`, `RestartSec=5`, `KillSignal=SIGTERM`, `TimeoutStopSec=90`, `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, and `ProtectHome=true`. Store environment values in a root-readable file outside the repository and keep application logs free of webhook URLs, RPC credentials, private keys, and account secrets.

The process handles SIGINT/SIGTERM, records durable heartbeat state, bounds scan ranges, retries RPC transport failures, and stops advancing checkpoints when the providers disagree. It raises deduplicated alerts for provider/RPC failures, stalled scanning, confirmed-but-uncredited observations, open financial incidents, and webhook delivery failures.

## Health queries

```sql
SELECT worker_key, status, last_heartbeat_at, last_success_at,
       last_scanned_block, consecutive_errors, last_error
FROM execution_worker_heartbeats
ORDER BY updated_at DESC;
```

```sql
SELECT worker_key, alert_type, severity, details, first_seen_at,
       last_seen_at, last_notified_at, resolved_at
FROM execution_worker_alerts
WHERE resolved_at IS NULL
ORDER BY last_seen_at DESC;
```

## Incident handling

If provider heads/hashes disagree, the scanner stalls, an eligible deposit remains uncredited, or a financial incident is open:

1. Keep deposits and live execution disabled.
2. Preserve checkpoint, lifecycle, journal, and incident records.
3. Verify both RPC providers against the same finalized Polygon block and inspect the receipt/log identity.
4. Reconcile the affected account and token using independent chain evidence.
5. Do not manually edit or delete ledger entries, invent replacement funds, or clear account restrictions without an audited and authorized resolution.

Live Polygon deposit crediting and real-fund withdrawal release have **not** been verified by this worker implementation. Testnet/fork and independent security-review evidence remain release gates.
