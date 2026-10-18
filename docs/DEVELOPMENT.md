# Development guide

## Requirements

- Node.js 22 or newer; npm 10 or newer.
- GitHub Actions uses Node.js 22.
- A browser EVM wallet for manual wallet UX. A WalletConnect project ID is required to enable WalletConnect-supported connectors in a future provider configuration.

## Setup

```sh
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`. Wallet balance queries use the connected browser wallet RPC. The Live market data panel calls `GET /api/market/snapshot?pair=WMATIC%2FUSDC`; the configured provider must implement `GET {MARKET_DATA_BASE_URL}/snapshot?pair=...` and return the normalized snapshot contract described in `src/lib/market/provider.ts`. The Historical backtest panel calls `POST /api/backtest` and reports simulated replay only. The optional autonomous paper worker runs as a separate Node process and uses PostgreSQL for its durable ledger and stop controls.

## Environment variables

| Variable | Meaning | Safe default / notes |
| --- | --- | --- |
| `NEXT_PUBLIC_CHAIN_ID` | Expected Polygon chain ID | `137`; configuration rejects other chains |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect project ID | Optional until connector is configured |
| `POLYGON_RPC_URL` | Trusted server-side RPC URL | HTTPS required outside localhost |
| `MARKET_DATA_BASE_URL` | Trusted provider base URL | Server requests `GET {base}/snapshot?pair=...`; response must match the normalized snapshot schema and include at least 22 ordered candles |
| `MARKET_DATA_API_KEY` | Provider secret | Sent as a server-side Bearer token; never use a `NEXT_PUBLIC_` prefix |
| `DATABASE_URL` | PostgreSQL connection string | Required for durable paper-worker ledger; use TLS for remote databases and keep credentials secret |
| `TREEBOT_MARKET_PAIRS` | Comma-separated normalized provider pair IDs | Example `WMATIC/USDC`; each pair requires the provider snapshot contract |
| `TREEBOT_PAPER_STARTING_EQUITY_QUOTE` | Initial simulated quote cash per pair | Default `1000`; simulation units only, not wallet funds |
| `TREEBOT_PAPER_MAX_NOTIONAL_QUOTE` | Maximum simulated entry notional per pair | Default `100` quote units |
| `TREEBOT_PAPER_POLL_MS` | Worker polling interval | Default `15000`; minimum 5000 ms |
| `TREEBOT_TRADING_MODE` | Intended runtime mode | `paper` only |
| `TREEBOT_LIVE_TRADING_ENABLED` | Additional live gate | Must remain `false`; live adapter absent |
| `TREEBOT_DEPOSITS_ENABLED` | Deposit gate | Must remain `false`; current config rejects `true` |
| `TREEBOT_MIN_CAPITAL_POL` | Minimum starting capital | `150` POL |
| `TREEBOT_GAS_RESERVE_POL` | Native reserve target | `2` POL default; user must review gas conditions |
| `TREEBOT_MAX_TRADE_POL` | Maximum trade size | `5` |
| `TREEBOT_MAX_DAILY_LOSS_PERCENT` | Daily loss circuit breaker | `2` percent |
| `TREEBOT_MAX_DRAWDOWN_PERCENT` | Portfolio drawdown circuit breaker | `8` percent |
| `TREEBOT_MAX_SLIPPAGE_BPS` | Maximum modeled slippage | `50` bps |
| `TREEBOT_MIN_EXPECTED_NET_RETURN_BPS` | Minimum cost-adjusted expected edge | `30` bps |
| `TREEBOT_MAX_TRADES_PER_HOUR` | Frequency guard | `4` |

Never commit `.env.local`, RPC credentials, API keys or wallet secrets. The application does not need a backend private key.

## Checks

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run format:check
npm audit --audit-level=high
```

Use Node.js 22 to match CI. On a fresh clone run `npm install`. To configure the durable paper worker, set `DATABASE_URL`, `MARKET_DATA_BASE_URL`, and `TREEBOT_MARKET_PAIRS`, then run `npm run ledger:migrate`. Start the worker with `npm run worker:paper`. It is paused by default; use `npm run paper:control -- enable` to enable paper cycles, `npm run paper:control -- disable` to pause new entries, `npm run paper:control -- emergency-stop` for the durable stop, and `npm run paper:control -- clear-stop` only to clear the stop (it does not enable trading). These controls affect paper simulation only.

## Current limitations

The health endpoint describes process/config health only; it does not prove RPC health or worker liveness. The dashboard polls the PostgreSQL paper ledger for worker controls, simulated equity, realized paper P&L, and recent simulated fills. Worker operation still requires an external PostgreSQL database, configured provider, and a separately supervised worker process. Historical replay and paper fills are simulation only. Real swaps, deposits, and withdrawals remain disabled.
