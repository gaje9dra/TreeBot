-- Phase 2.4B: durable chain watcher state and explicit fund lifecycle.
-- Schema-only; does not enable deposits, withdrawals, or live transaction submission.

CREATE TABLE IF NOT EXISTS execution_chain_watcher_state (
  chain_id INTEGER NOT NULL CHECK (chain_id = 137),
  watcher_key TEXT NOT NULL,
  next_block NUMERIC(78,0) NOT NULL CHECK (next_block >= 0),
  last_scanned_block_hash TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, watcher_key)
);

CREATE TABLE IF NOT EXISTS execution_deposit_lifecycle (
  chain_id INTEGER NOT NULL CHECK (chain_id = 137),
  transaction_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL CHECK (log_index >= 0),
  account_id TEXT NOT NULL,
  asset_address TEXT NOT NULL,
  sender_address TEXT NOT NULL,
  vault_address TEXT NOT NULL,
  amount_base_units NUMERIC(78,0) NOT NULL CHECK (amount_base_units > 0),
  block_number NUMERIC(78,0) NOT NULL CHECK (block_number >= 0),
  block_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('detected','provisional','confirmed','reversed','reconciliation_required')),
  confirmations INTEGER NOT NULL DEFAULT 0 CHECK (confirmations >= 0),
  required_confirmations INTEGER NOT NULL CHECK (required_confirmations > 0),
  credited_event_key TEXT UNIQUE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reversed_at TIMESTAMPTZ,
  PRIMARY KEY (chain_id, transaction_hash, log_index)
);
CREATE INDEX IF NOT EXISTS execution_deposit_lifecycle_status_idx
  ON execution_deposit_lifecycle(status, updated_at);
CREATE INDEX IF NOT EXISTS execution_deposit_lifecycle_block_idx
  ON execution_deposit_lifecycle(chain_id, block_number);

CREATE TABLE IF NOT EXISTS execution_withdrawal_audit_events (
  id BIGSERIAL PRIMARY KEY,
  withdrawal_id TEXT NOT NULL REFERENCES execution_withdrawal_reservations(id),
  from_status TEXT,
  to_status TEXT NOT NULL CHECK (to_status IN ('reserved','submitted','confirmed','reverted','unknown','cancelled')),
  event_key TEXT NOT NULL UNIQUE,
  transaction_hash TEXT,
  nonce BIGINT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS execution_withdrawal_audit_created_idx
  ON execution_withdrawal_audit_events(withdrawal_id, created_at);

ALTER TABLE execution_withdrawal_reservations
  ADD COLUMN IF NOT EXISTS chain_id INTEGER NOT NULL DEFAULT 137 CHECK (chain_id = 137),
  ADD COLUMN IF NOT EXISTS nonce BIGINT,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT CHECK (length(failure_reason) <= 500),
  ADD COLUMN IF NOT EXISTS confirmation_block NUMERIC(78,0),
  ADD COLUMN IF NOT EXISTS confirmation_block_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS execution_withdrawal_account_nonce_idx
  ON execution_withdrawal_reservations(chain_id, account_id, nonce)
  WHERE nonce IS NOT NULL;

-- Persistent journal records distinguish observations and valuation metadata from cash flows.
CREATE TABLE IF NOT EXISTS execution_asset_valuations (
  account_id TEXT NOT NULL,
  asset_address TEXT NOT NULL,
  valuation_source TEXT NOT NULL,
  quote_asset_address TEXT NOT NULL,
  price_numerator NUMERIC(78,0) NOT NULL CHECK (price_numerator >= 0),
  price_denominator NUMERIC(78,0) NOT NULL CHECK (price_denominator > 0),
  token_decimals SMALLINT NOT NULL CHECK (token_decimals BETWEEN 0 AND 36),
  observed_at TIMESTAMPTZ NOT NULL,
  freshness_deadline TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(account_id, asset_address, observed_at)
);
CREATE INDEX IF NOT EXISTS execution_asset_valuations_latest_idx
  ON execution_asset_valuations(account_id, asset_address, observed_at DESC);

CREATE TABLE IF NOT EXISTS execution_open_positions (
  account_id TEXT NOT NULL,
  asset_address TEXT NOT NULL,
  quantity_base_units NUMERIC(78,0) NOT NULL CHECK (quantity_base_units >= 0),
  cost_basis_quote_base_units NUMERIC(78,0) NOT NULL CHECK (cost_basis_quote_base_units >= 0),
  quote_asset_address TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(account_id, asset_address, quote_asset_address)
);
