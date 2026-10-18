# TreeBot

Autonomous Polygon PoS trading research platform. The initial implementation prioritizes verified data, explainable decisions, and safe paper trading.

## Safety status

- Polygon PoS network target: chain ID 137.
- Minimum strategy eligibility: 150 POL, checked against a connected wallet's observed native balance and a configurable gas reserve.
- Paper trading is the default mode.
- Live trading and deposits are disabled by default and must not be enabled without provider integration verification, explicit owner authorization, and an independent smart-contract security review if custody contracts are added.
- Wallet connection never authorizes transfers. TreeBot never requests seed phrases or private keys.
- Simulated results are clearly labeled and must not be represented as actual performance.

## Project status

This repository is being initialized in stages. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/SECURITY.md](docs/SECURITY.md), and [docs/ROADMAP.md](docs/ROADMAP.md) for the design, trust boundaries, and remaining production work.

## Development

Requirements: Node.js 22+ and npm 10+.

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Useful checks:

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for configuration and workflow.

## Disclaimer

Cryptocurrency trading can lose principal. Signals and backtests do not guarantee returns. Do not deploy real funds or enable live trading without a security review and appropriate operational controls.