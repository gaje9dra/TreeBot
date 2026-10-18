import type { PaperTrade, TradeDecision } from "./types";

export interface PaperBrokerConfig {
  feeBps: number;
  slippageBps: number;
}

/** Simulation only. No RPC transaction signing or token transfers occur here. */
export class PaperBroker {
  private readonly trades = new Map<string, PaperTrade>();
  constructor(private readonly config: PaperBrokerConfig = { feeBps: 30, slippageBps: 20 }) {
    if (![config.feeBps, config.slippageBps].every((v) => Number.isFinite(v) && v >= 0)) throw new Error("Invalid paper broker cost configuration.");
  }

  execute(decision: TradeDecision, price: number, now = Date.now()): PaperTrade {
    if (this.trades.has(decision.id)) return this.trades.get(decision.id)!;
    if (!decision.accepted || !["buy", "sell"].includes(decision.action)) throw new Error("Paper broker requires an accepted buy/sell decision.");
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(decision.proposedNotionalQuote) || decision.proposedNotionalQuote <= 0) throw new Error("Invalid simulated order parameters.");
    const notional = decision.proposedNotionalQuote;
    const side = decision.action as "buy" | "sell";
    const slippageQuote = notional * this.config.slippageBps / 10_000;
    const feesQuote = notional * this.config.feeBps / 10_000;
    const executionPrice = price * (side === "buy" ? 1 + this.config.slippageBps / 10_000 : 1 - this.config.slippageBps / 10_000);
    const trade: PaperTrade = {
      id: `paper-${decision.id}`, decisionId: decision.id, pair: decision.pair, side,
      notionalQuote: notional, executionPrice, feesQuote, slippageQuote,
      status: "simulated", simulated: true, timestamp: now
    };
    this.trades.set(decision.id, trade);
    return trade;
  }

  list(): PaperTrade[] {
    return [...this.trades.values()].sort((a, b) => b.timestamp - a.timestamp);
  }
}
