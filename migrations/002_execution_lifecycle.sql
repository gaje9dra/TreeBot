-- Durable execution-intent ledger only. Does not move funds or enable mainnet execution.
CREATE TABLE IF NOT EXISTS execution_authorizations (
  id TEXT PRIMARY KEY,
  owner_address TEXT NOT NULL,
  chain_id INTEGER NOT NULL CHECK (chain_id = 137),
  allowed_tokens JSONB NOT NULL CHECK (jsonb_typeof(allowed_tokens) = 'array'),
  allowed_targets JSONB NOT NULL CHECK (jsonb_typeof(allowed_targets) = 'array'),
  maximum_sell_amount NUMERIC(78, 0) NOT NULL CHECK (maximum_sell_amount > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  authorized_by TEXT NOT NULL CHECK (authorized_by IN ('owner_wallet', 'audited_smart_account')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS execution_transactions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  chain_id INTEGER NOT NULL CHECK (chain_id = 137),
  wallet_address TEXT NOT NULL,
  sell_token TEXT NOT NULL,
  buy_token TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  sell_amount NUMERIC(78, 0) NOT NULL CHECK (sell_amount > 0),
  quote JSONB NOT NULL,
  authorization_id TEXT NOT NULL REFERENCES execution_authorizations(id),
  risk_checks JSONB NOT NULL,
  prepared_transaction JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared','awaiting_signature','signed','submitted','pending','confirmed','reverted','replaced','failed','unknown')),
  tx_hash TEXT UNIQUE,
  nonce BIGINT,
  confirmation_block NUMERIC(78, 0),
  actual_sell_amount NUMERIC(78, 0),
  actual_buy_amount NUMERIC(78, 0),
  actual_gas_wei NUMERIC(78, 0),
  execution_price NUMERIC(78, 0),
  error_code TEXT,
  error_message TEXT CHECK (length(error_message) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMPTZ,
  CHECK (sell_token <> buy_token)
);
CREATE INDEX IF NOT EXISTS execution_transactions_status_updated_idx ON execution_transactions(status, updated_at);
CREATE INDEX IF NOT EXISTS execution_transactions_wallet_nonce_idx ON execution_transactions(chain_id, wallet_address, nonce) WHERE nonce IS NOT NULL;

CREATE TABLE IF NOT EXISTS execution_audit_events (
  id BIGSERIAL PRIMARY KEY,
  transaction_id TEXT REFERENCES execution_transactions(id),
  event_type TEXT NOT NULL,
  actor_address TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS execution_audit_events_transaction_created_idx ON execution_audit_events(transaction_id, created_at);
