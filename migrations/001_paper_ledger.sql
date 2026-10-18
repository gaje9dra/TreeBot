CREATE TABLE IF NOT EXISTS treebot_control (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  paper_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  emergency_stop BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO treebot_control (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS paper_portfolios (
  pair TEXT PRIMARY KEY,
  starting_equity_quote NUMERIC(30, 10) NOT NULL CHECK (starting_equity_quote > 0),
  cash_quote NUMERIC(30, 10) NOT NULL CHECK (cash_quote >= 0),
  daily_start_equity_quote NUMERIC(30, 10) NOT NULL,
  daily_start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  peak_equity_quote NUMERIC(30, 10) NOT NULL,
  consecutive_losses INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_losses >= 0),
  gas_spent_quote NUMERIC(30, 10) NOT NULL DEFAULT 0 CHECK (gas_spent_quote >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS paper_decisions (
  decision_id TEXT PRIMARY KEY,
  pair TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('buy', 'sell', 'hold', 'skip')),
  accepted BOOLEAN NOT NULL,
  score NUMERIC(20, 8) NOT NULL,
  reasons JSONB NOT NULL,
  market_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS paper_decisions_pair_created_idx ON paper_decisions(pair, created_at DESC);

CREATE TABLE IF NOT EXISTS paper_positions (
  pair TEXT PRIMARY KEY,
  base_token TEXT NOT NULL,
  quote_token TEXT NOT NULL,
  quantity_base NUMERIC(30, 12) NOT NULL CHECK (quantity_base > 0),
  entry_price NUMERIC(30, 12) NOT NULL CHECK (entry_price > 0),
  entry_notional_quote NUMERIC(30, 10) NOT NULL CHECK (entry_notional_quote > 0),
  entry_fees_quote NUMERIC(30, 10) NOT NULL DEFAULT 0,
  entry_gas_quote NUMERIC(30, 10) NOT NULL DEFAULT 0,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS paper_trades (
  id BIGSERIAL PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE REFERENCES paper_decisions(decision_id),
  pair TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  notional_quote NUMERIC(30, 10) NOT NULL CHECK (notional_quote > 0),
  execution_price NUMERIC(30, 12) NOT NULL CHECK (execution_price > 0),
  quantity_base NUMERIC(30, 12) NOT NULL CHECK (quantity_base > 0),
  fees_quote NUMERIC(30, 10) NOT NULL,
  slippage_quote NUMERIC(30, 10) NOT NULL,
  gas_quote NUMERIC(30, 10) NOT NULL,
  realized_pnl_quote NUMERIC(30, 10),
  status TEXT NOT NULL DEFAULT 'simulated' CHECK (status = 'simulated'),
  simulated BOOLEAN NOT NULL DEFAULT TRUE CHECK (simulated = TRUE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS paper_trades_pair_created_idx ON paper_trades(pair, created_at DESC);
