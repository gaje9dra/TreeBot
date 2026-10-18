import { DEFAULT_RISK_LIMITS, evaluateOpportunity, type EvaluateInput } from "@/lib/trading/decision-engine";
import { loadMarketSnapshot, type MarketProviderOptions } from "@/lib/market/provider";
import type { MarketSnapshot, PortfolioState, TradeDecision } from "@/lib/trading/types";
import type { PaperControlState, RecordDecisionResult } from "@/lib/ledger/postgres";

export interface PaperLedger {
  getControl(): Promise<PaperControlState>;
  recordHeartbeat?(): Promise<void>;
  getPortfolio(pair: string, markPrice: number, now?: number): Promise<PortfolioState>;
  recordDecision(market: MarketSnapshot, decision: TradeDecision, now?: number): Promise<RecordDecisionResult>;
}

export interface PaperCycleDependencies {
  ledger: PaperLedger;
  marketLoader?: (pair: string, options?: MarketProviderOptions) => Promise<MarketSnapshot>;
  evaluate?: (input: EvaluateInput) => TradeDecision;
  env?: Record<string, string | undefined>;
}

export type PaperCycleResult =
  | { status: "paused"; reason: string }
  | { status: "evaluated"; decision: TradeDecision; record: RecordDecisionResult };

export async function runPaperCycle(
  pair: string,
  now: number,
  dependencies: PaperCycleDependencies,
): Promise<PaperCycleResult> {
  await dependencies.ledger.recordHeartbeat?.();
  const control = await dependencies.ledger.getControl();
  if (!control.enabled || control.emergencyStop) {
    return { status: "paused", reason: control.emergencyStop ? "Emergency stop is active." : "Paper trading is disabled." };
  }

  const env = dependencies.env ?? process.env;
  const market = await (dependencies.marketLoader ?? loadMarketSnapshot)(pair, { now, env });
  const portfolio = await dependencies.ledger.getPortfolio(pair, market.price, now);
  const maximumNotional = Number(env.TREEBOT_PAPER_MAX_NOTIONAL_QUOTE ?? 100);
  if (!Number.isFinite(maximumNotional) || maximumNotional <= 0) {
    throw new Error("TREEBOT_PAPER_MAX_NOTIONAL_QUOTE must be a positive finite number.");
  }
  const limits = {
    ...DEFAULT_RISK_LIMITS,
    minimumCapitalPol: 0,
    gasReservePol: 0,
    maximumTradePol: maximumNotional,
    maximumPairExposurePercent: 100,
  };
  const evaluate = dependencies.evaluate ?? evaluateOpportunity;
  const decision = evaluate({
    market,
    portfolio,
    availableCapitalPol: portfolio.availableQuote,
    limits,
    now,
  });
  const record = await dependencies.ledger.recordDecision(market, decision, now);
  return { status: "evaluated", decision, record };
}
