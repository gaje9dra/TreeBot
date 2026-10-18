-- Phase 2.4I: auditable per-trade accounting, with explicit pending cost-basis states.
CREATE TABLE IF NOT EXISTS execution_trade_accounting (
  execution_id TEXT PRIMARY KEY REFERENCES execution_transactions(id),
  chain_id INTEGER NOT NULL CHECK (chain_id = 137),
  account_id TEXT NOT NULL,
  sell_asset TEXT NOT NULL,
  buy_asset TEXT NOT NULL,
  sell_amount_base_units NUMERIC(78,0) NOT NULL CHECK (sell_amount_base_units >= 0),
  buy_amount_base_units NUMERIC(78,0) NOT NULL CHECK (buy_amount_base_units >= 0),
  gas_wei NUMERIC(78,0) NOT NULL CHECK (gas_wei >= 0),
  quote_asset_address TEXT,
  cost_basis_allocated_quote_base_units NUMERIC(78,0) CHECK (cost_basis_allocated_quote_base_units IS NULL OR cost_basis_allocated_quote_base_units >= 0),
  realized_pnl_quote_base_units NUMERIC(79,0),
  accounting_status TEXT NOT NULL CHECK (accounting_status IN ('pending','complete','reconciliation_required','not_applicable')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS execution_trade_accounting_account_status_idx
  ON execution_trade_accounting(account_id,accounting_status,updated_at DESC);
