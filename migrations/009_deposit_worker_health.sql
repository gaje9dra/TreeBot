-- Phase 2.4G: durable health and alert state for supervised execution workers.
CREATE TABLE IF NOT EXISTS execution_worker_heartbeats (
  worker_key TEXT PRIMARY KEY,
  worker_type TEXT NOT NULL CHECK (worker_type IN ('deposit','valuation')),
  status TEXT NOT NULL CHECK (status IN ('starting','running','degraded','stopped','disabled')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_success_at TIMESTAMPTZ,
  last_scanned_block BIGINT CHECK (last_scanned_block IS NULL OR last_scanned_block >= 0),
  consecutive_errors INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_errors >= 0),
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS execution_worker_alerts (
  id BIGSERIAL PRIMARY KEY,
  worker_key TEXT NOT NULL REFERENCES execution_worker_heartbeats(worker_key),
  alert_type TEXT NOT NULL CHECK (alert_type IN (
    'rpc_error','rpc_disagreement','scanner_stalled','uncredited_deposit',
    'financial_incident','alert_delivery_failed','configuration_error','database_error','cost_basis_pending','valuation_stale'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  dedupe_key TEXT NOT NULL UNIQUE,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_notified_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  acknowledged_at TIMESTAMPTZ
);

ALTER TABLE execution_worker_heartbeats
  DROP CONSTRAINT IF EXISTS execution_worker_heartbeats_worker_type_check;
ALTER TABLE execution_worker_heartbeats
  ADD CONSTRAINT execution_worker_heartbeats_worker_type_check CHECK (worker_type IN ('deposit','valuation'));

ALTER TABLE execution_worker_alerts
  ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMPTZ;
ALTER TABLE execution_worker_alerts
  DROP CONSTRAINT IF EXISTS execution_worker_alerts_alert_type_check;
ALTER TABLE execution_worker_alerts
  ADD CONSTRAINT execution_worker_alerts_alert_type_check
  CHECK (alert_type IN (
    'rpc_error','rpc_disagreement','scanner_stalled','uncredited_deposit',
    'financial_incident','alert_delivery_failed','configuration_error','database_error','cost_basis_pending','valuation_stale'
  ));

CREATE INDEX IF NOT EXISTS execution_worker_alerts_open_idx
  ON execution_worker_alerts(worker_key, severity, last_seen_at DESC)
  WHERE resolved_at IS NULL;
