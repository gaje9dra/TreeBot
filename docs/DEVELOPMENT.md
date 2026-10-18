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

Open `http://localhost:3000`. Wallet balance queries require the browser wallet to be connected and use the wallet RPC. Server-side on-chain reads require `POLYGON_RPC_URL`.

## Environment variables

| Variable | Meaning | Safe default / notes |
| --- | --- | --- |
| `NEXT_PUBLIC_CHAIN_ID` | Expected Polygon chain ID | `137`; configuration rejects other chains |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect project ID | Optional until connector is configured |
| `POLYGON_RPC_URL` | Trusted server-side RPC URL | HTTPS required outside localhost |
| `MARKET_DATA_BASE_URL` | Approved provider's API base URL | Not wired to a market feed yet |
| `MARKET_DATA_API_KEY` | Provider secret | Server-side only; never use a `NEXT_PUBLIC_` prefix |
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

Use Node.js 22 to match CI. On a fresh clone run `npm install` (the lockfile should be committed when generated using the chosen npm version).

## Current limitations

The health endpoint describes process/config health only; it does not prove RPC health, market freshness or trading-worker liveness. The dashboard activity events are local UI events unless explicitly stated otherwise. Historical replay and paper fills are simulation only. Real swaps, deposits, withdrawals and persistence are not yet wired.
