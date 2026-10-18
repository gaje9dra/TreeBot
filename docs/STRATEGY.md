# Strategy specification

## Strategy family

The initial baseline combines short/long simple moving-average trend, RSI momentum bands and realized candle volatility. It only evaluates a candidate when market input candles validate and the snapshot is fresh, liquidity clears the configured minimum, an exit route is declared executable, slippage is bounded, costs are finite, and portfolio risk gates remain clear.

This is an explainable research baseline, not a learned strategy. The returned score is a heuristic ranking scalar, not a calibrated probability of profit. Expected edge is an illustrative conservative proxy, not a validated forecast. Do not use it to justify real orders until walk-forward and out-of-sample evaluation supports it.

## Cost accounting

The core decision estimates both-side swap fees and slippage, gas normalized by notional, plus configured return threshold. A future production quote must include token transfer tax (where relevant), aggregator fee, route price impact, native gas, failure costs where measurable, and the cost of a realistic exit route.

## Risk defaults

- 150 POL minimum starting capital, with an additional configurable native gas reserve.
- 5 POL max candidate size.
- 2% max daily loss.
- 8% max portfolio drawdown.
- 50 bps max modeled slippage.
- 30 bps minimum expected net edge.
- 4 trades/hour, 3 consecutive losses, 20% pair concentration ceiling.

These values are engineering defaults only, not investment advice, and must be validated before use. The minimum capital rule is eligibility only, not proof of diversification or profitability.

## Backtesting limitations

The bar replay applies fees, slippage and a per-trade gas estimate and reports drawdown, win rate, average winners/losers, profit factor, expectancy, net return and a buy-and-hold benchmark. It uses next-bar entry/exit prices to reduce look-ahead bias, but it is not a realistic market microstructure simulator. It currently lacks sourced datasets, token risk filtering, historical liquidity/impact modeling, failed transactions, MEV, provider outages, portfolio token mark-to-market, and walk-forward orchestration.

No performance numbers are asserted by this repository. Run the backtest against sourced historical data, then evaluate untouched out-of-sample windows before forming any profitability conclusion.
