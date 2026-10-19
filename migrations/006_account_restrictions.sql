-- Phase 2.4D: durable account-level restrictions after financial-integrity incidents.
-- This does not enable deposits, withdrawals, or live transaction submission.
CREATE TABLE IF NOT EXISTS execution_account_restrictions (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL,
  restriction_key TEXT NOT NULL UNIQUE,
  restriction_type TEXT NOT NULL CHECK (restriction_type IN ('deposit_reorg','ledger_mismatch','security_incident','operator_hold')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  CHECK ((status='active' AND resolved_at IS NULL) OR (status='resolved' AND resolved_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS execution_account_restrictions_active_idx
  ON execution_account_restrictions(account_id, created_at DESC) WHERE status='active';

CREATE TABLE IF NOT EXISTS execution_financial_incidents (
  id BIGSERIAL PRIMARY KEY,
  incident_key TEXT NOT NULL UNIQUE,
  incident_type TEXT NOT NULL CHECK (incident_type IN ('deposit_reorg_after_credit','ledger_mismatch','settlement_conflict')),
  account_id TEXT NOT NULL,
  asset_address TEXT,
  amount_base_units NUMERIC(78,0),
  chain_id INTEGER NOT NULL CHECK (chain_id=137),
  transaction_hash TEXT,
  log_index INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','written_off')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS execution_financial_incidents_open_idx
  ON execution_financial_incidents(status, created_at) WHERE status IN ('open','investigating');
