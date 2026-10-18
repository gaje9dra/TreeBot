import { Pool, type PoolClient } from "pg";
import type { MarketSnapshot, PortfolioState, TradeDecision } from "@/lib/trading/types";

export interface PaperControlState {
  enabled: boolean;
  emergencyStop: boolean;
}

export interface RecordDecisionResult {
  tradeRecorded: boolean;
  duplicate?: boolean;
  reason?: string;
}

export interface PaperTradeRecord {
  id: number;
  decisionId: string;
  pair: string;
  side: "buy" | "sell";
  notionalQuote: number;
  executionPrice: number;
  quantityBase: number;
  feesQuote: number;
  slippageQuote: number;
  gasQuote: number;
  realizedPnlQuote: number | null;
  status: "simulated";
  createdAt: string;
}

export interface PaperDashboardSnapshot {
  control: PaperControlState;
  portfolio: PortfolioState;
  startingEquityQuote: number;
  realizedPnlQuote: number;
  trades: PaperTradeRecord[];
}

export function createLedgerPool(env: Record<string, string | undefined> = process.env): Pool {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for the durable paper ledger.");
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL is not a valid PostgreSQL connection URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres:// or postgresql:// protocol.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    ssl: local ? false : { rejectUnauthorized: true },
  });
}

function numberValue(value: string | number | null | undefined): number {
  const result = Number(value ?? 0);
  if (!Number.isFinite(result)) throw new Error("Ledger contains a non-finite numeric value.");
  return result;
}

export class PostgresPaperLedger {
  constructor(
    private readonly pool: Pool,
    private readonly startingEquityQuote = numberValue(process.env.TREEBOT_PAPER_STARTING_EQUITY_QUOTE ?? 1000),
  ) {
    if (this.startingEquityQuote <= 0) throw new Error("Paper starting equity must be positive.");
  }

  async getControl(): Promise<PaperControlState> {
    const result = await this.pool.query("SELECT paper_enabled, emergency_stop FROM treebot_control WHERE id = 1");
    if (!result.rows[0]) throw new Error("Paper ledger schema is missing; run npm run ledger:migrate first.");
    return { enabled: result.rows[0].paper_enabled === true, emergencyStop: result.rows[0].emergency_stop === true };
  }

  async getPortfolio(pair: string, markPrice?: number, now = Date.now()): Promise<PortfolioState> {
    if (markPrice !== undefined && (!Number.isFinite(markPrice) || markPrice <= 0)) throw new Error("Mark price must be positive when supplied.");
    await this.pool.query(
      `INSERT INTO paper_portfolios
       (pair, starting_equity_quote, cash_quote, daily_start_equity_quote, daily_start_date, peak_equity_quote)
       VALUES ($1, $2, $2, $2, CURRENT_DATE, $2)
       ON CONFLICT (pair) DO NOTHING`,
      [pair, this.startingEquityQuote],
    );
    const portfolioResult = await this.pool.query("SELECT * FROM paper_portfolios WHERE pair = $1", [pair]);
    const row = portfolioResult.rows[0];
    if (!row) throw new Error("Could not load paper portfolio.");
    const positionResult = await this.pool.query("SELECT * FROM paper_positions WHERE pair = $1", [pair]);
    const position = positionResult.rows[0];
    const cash = numberValue(row.cash_quote);
    const quantity = position ? numberValue(position.quantity_base) : 0;
    const effectiveMarkPrice = markPrice ?? (position ? numberValue(position.entry_price) : 0);
    const equity = cash + quantity * effectiveMarkPrice;
    const peak = Math.max(numberValue(row.peak_equity_quote), equity);
    const today = new Date(now).toISOString().slice(0, 10);
    const dailyStartDate = String(row.daily_start_date).slice(0, 10);
    let dailyStart = numberValue(row.daily_start_equity_quote);
    let gasSpent = numberValue(row.gas_spent_quote);
    if (dailyStartDate !== today) {
      dailyStart = equity;
      gasSpent = 0;
      await this.pool.query(
        "UPDATE paper_portfolios SET daily_start_equity_quote = $2, daily_start_date = $3, gas_spent_quote = 0 WHERE pair = $1",
        [pair, dailyStart, today],
      );
    }
    await this.pool.query("UPDATE paper_portfolios SET peak_equity_quote = GREATEST(peak_equity_quote, $2), updated_at = NOW() WHERE pair = $1", [pair, peak]);
    const tradesResult = await this.pool.query(
      "SELECT COUNT(*)::int AS count FROM paper_trades WHERE pair = $1 AND created_at >= $2",
      [pair, new Date(now - 60 * 60 * 1000)],
    );
    return {
      equityQuote: equity,
      availableQuote: cash,
      reservedQuote: position ? numberValue(position.entry_notional_quote) : 0,
      dailyStartEquityQuote: dailyStart,
      peakEquityQuote: peak,
      openPositions: position ? [{ pair, notionalQuote: quantity * markPrice, direction: "long" }] : [],
      consecutiveLosses: Number(row.consecutive_losses),
      tradesLastHour: Number(tradesResult.rows[0]?.count ?? 0),
      gasSpentQuote: gasSpent,
    };
  }

  async getRecentTrades(pair: string, limit = 20): Promise<PaperTradeRecord[]> {
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    const result = await this.pool.query(
      "SELECT id, decision_id, pair, side, notional_quote, execution_price, quantity_base, fees_quote, slippage_quote, gas_quote, realized_pnl_quote, status, created_at FROM paper_trades WHERE pair = $1 ORDER BY created_at DESC LIMIT $2",
      [pair, safeLimit],
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      decisionId: String(row.decision_id),
      pair: String(row.pair),
      side: row.side as "buy" | "sell",
      notionalQuote: numberValue(row.notional_quote),
      executionPrice: numberValue(row.execution_price),
      quantityBase: numberValue(row.quantity_base),
      feesQuote: numberValue(row.fees_quote),
      slippageQuote: numberValue(row.slippage_quote),
      gasQuote: numberValue(row.gas_quote),
      realizedPnlQuote: row.realized_pnl_quote === null ? null : numberValue(row.realized_pnl_quote),
      status: "simulated",
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async getDashboard(pair: string, markPrice?: number, now = Date.now()): Promise<PaperDashboardSnapshot> {
    const control = await this.getControl();
    const portfolio = await this.getPortfolio(pair, markPrice, now);
    const startingResult = await this.pool.query("SELECT starting_equity_quote FROM paper_portfolios WHERE pair = $1", [pair]);
    const pnlResult = await this.pool.query(
      "SELECT COALESCE(SUM(realized_pnl_quote), 0) AS realized_pnl_quote FROM paper_trades WHERE pair = $1",
      [pair],
    );
    return {
      control,
      portfolio,
      startingEquityQuote: numberValue(startingResult.rows[0]?.starting_equity_quote),
      realizedPnlQuote: numberValue(pnlResult.rows[0]?.realized_pnl_quote),
      trades: await this.getRecentTrades(pair, 20),
    };
  }

  async recordDecision(market: MarketSnapshot, decision: TradeDecision, now = Date.now()): Promise<RecordDecisionResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const control = await client.query("SELECT paper_enabled, emergency_stop FROM treebot_control WHERE id = 1 FOR UPDATE");
      if (!control.rows[0]) throw new Error("Paper ledger schema is missing; run npm run ledger:migrate first.");
      const inserted = await client.query(
        `INSERT INTO paper_decisions (decision_id, pair, action, accepted, score, reasons, market_snapshot, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
         ON CONFLICT (decision_id) DO NOTHING RETURNING decision_id`,
        [decision.id, decision.pair, decision.action, decision.accepted, decision.score, JSON.stringify(decision.reasons), JSON.stringify(market), new Date(now)],
      );
      if (inserted.rowCount === 0) {
        await client.query("COMMIT");
        return { tradeRecorded: false, duplicate: true, reason: "Decision already recorded; idempotent replay ignored." };
      }
      if (control.rows[0].paper_enabled !== true || control.rows[0].emergency_stop === true) {
        await client.query("COMMIT");
        return { tradeRecorded: false, reason: "Paper trading is disabled or emergency stop is active." };
      }
      if (!decision.accepted || (decision.action !== "buy" && decision.action !== "sell")) {
        await client.query("COMMIT");
        return { tradeRecorded: false, reason: "Decision did not approve a buy/sell action." };
      }

      const portfolioResult = await client.query("SELECT * FROM paper_portfolios WHERE pair = $1 FOR UPDATE", [market.pair]);
      const portfolio = portfolioResult.rows[0];
      if (!portfolio) throw new Error("Paper portfolio missing; run a paper cycle before recording a decision.");
      const positionResult = await client.query("SELECT * FROM paper_positions WHERE pair = $1 FOR UPDATE", [market.pair]);
      const position = positionResult.rows[0];
      const cash = numberValue(portfolio.cash_quote);
      const feeRate = market.swapFeeBps / 10_000;
      const slipRate = market.expectedSlippageBps / 10_000;
      const gas = market.gasCostQuote;
      let side: "buy" | "sell";
      let notional: number;
      let executionPrice: number;
      let quantity: number;
      let fees: number;
      let slippage: number;
      let realizedPnl: number | null = null;
      let cashAfter: number;
      let nextConsecutiveLosses = Number(portfolio.consecutive_losses);

      if (decision.action === "buy") {
        if (position) {
          await client.query("COMMIT");
          return { tradeRecorded: false, reason: "A position for this pair is already open; duplicate entries are blocked." };
        }
        notional = Math.min(decision.proposedNotionalQuote, Math.max(0, (cash - gas) / (1 + feeRate)));
        fees = notional * feeRate;
        if (notional <= 0 || notional + fees + gas > cash) {
          await client.query("COMMIT");
          return { tradeRecorded: false, reason: "Insufficient simulated quote cash after fees and gas reserve." };
        }
        side = "buy";
        executionPrice = market.price * (1 + slipRate);
        quantity = notional / executionPrice;
        slippage = notional * slipRate;
        cashAfter = cash - notional - fees - gas;
        await client.query(
          `INSERT INTO paper_positions (pair, base_token, quote_token, quantity_base, entry_price, entry_notional_quote, entry_fees_quote, entry_gas_quote, opened_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [market.pair, market.baseToken, market.quoteToken, quantity, executionPrice, notional, fees, gas, new Date(now)],
        );
      } else {
        if (!position) {
          await client.query("COMMIT");
          return { tradeRecorded: false, reason: "No open long position exists to close; short selling is not supported." };
        }
        side = "sell";
        quantity = numberValue(position.quantity_base);
        executionPrice = market.price * (1 - slipRate);
        notional = quantity * executionPrice;
        fees = notional * feeRate;
        slippage = quantity * market.price * slipRate;
        cashAfter = cash + notional - fees - gas;
        realizedPnl = notional - numberValue(position.entry_notional_quote) - numberValue(position.entry_fees_quote) - numberValue(position.entry_gas_quote) - fees - gas;
        nextConsecutiveLosses = realizedPnl < 0 ? nextConsecutiveLosses + 1 : 0;
        await client.query("DELETE FROM paper_positions WHERE pair = $1", [market.pair]);
      }

      const equityAfter = side === "buy" ? cashAfter + quantity * market.price : cashAfter;
      await client.query(
        `UPDATE paper_portfolios
         SET cash_quote = $2, peak_equity_quote = GREATEST(peak_equity_quote, $3),
             consecutive_losses = $4, gas_spent_quote = gas_spent_quote + $5, updated_at = NOW()
         WHERE pair = $1`,
        [market.pair, cashAfter, equityAfter, nextConsecutiveLosses, gas],
      );
      await client.query(
        `INSERT INTO paper_trades
         (decision_id, pair, side, notional_quote, execution_price, quantity_base, fees_quote, slippage_quote, gas_quote, realized_pnl_quote, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [decision.id, market.pair, side, notional, executionPrice, quantity, fees, slippage, gas, realizedPnl, new Date(now)],
      );
      await client.query("COMMIT");
      return { tradeRecorded: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export type { PoolClient };
