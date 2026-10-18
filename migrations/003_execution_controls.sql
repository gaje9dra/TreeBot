-- Durable execution controls and reconciliation. Does not enable signing/custody.
ALTER TABLE execution_transactions
  ADD COLUMN IF NOT EXISTS lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS execution_control (
  id SMALLINT PRIMARY KEY CHECK (id=1),
  emergency_stop BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mismatch_detected_at TIMESTAMPTZ
);
INSERT INTO execution_control (id,emergency_stop) VALUES (1,TRUE) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS execution_reconciliation (
  id BIGSERIAL PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  chain_balance NUMERIC(78,0) NOT NULL CHECK (chain_balance >= 0),
  ledger_balance NUMERIC(78,0) NOT NULL CHECK (ledger_balance >= 0),
  discrepancy NUMERIC(79,0) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('matched','mismatch')),
  reconciled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS execution_reconciliation_wallet_token_idx ON execution_reconciliation(wallet_address,token_address,reconciled_at DESC);

CREATE TABLE IF NOT EXISTS execution_ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('deposit','withdrawal','trade_sell','trade_buy','gas','fee','realized_pnl','position_adjustment')),
  asset_address TEXT NOT NULL,
  amount_base_units NUMERIC(78,0) NOT NULL,
  chain_id INTEGER NOT NULL CHECK (chain_id=137),
  transaction_hash TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS execution_ledger_account_asset_idx ON execution_ledger_entries(account_id,asset_address,created_at DESC);

CREATE TABLE IF NOT EXISTS execution_deposit_events (
  chain_id INTEGER NOT NULL CHECK (chain_id=137),
  transaction_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL CHECK (log_index >= 0),
  account_id TEXT NOT NULL,
  asset_address TEXT NOT NULL,
  amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  block_number NUMERIC(78,0) NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(chain_id,transaction_hash,log_index)
);
CREATE TABLE IF NOT EXISTS execution_withdrawal_reservations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  asset_address TEXT NOT NULL,
  recipient_address TEXT NOT NULL,
  amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
  status TEXT NOT NULL CHECK (status IN ('reserved','submitted','confirmed','reverted','unknown')),
  idempotency_key TEXT NOT NULL UNIQUE,
  transaction_hash TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS execution_withdrawal_account_status_idx ON execution_withdrawal_reservations(account_id,status);
