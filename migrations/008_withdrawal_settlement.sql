-- Phase 2.4F: explicit withdrawal submission and verified settlement state.
-- Actual signing/release remains disabled until custody and operator authorization are approved.
ALTER TABLE execution_withdrawal_reservations
  DROP CONSTRAINT IF EXISTS execution_withdrawal_reservations_status_check;
ALTER TABLE execution_withdrawal_reservations
  ADD CONSTRAINT execution_withdrawal_reservations_status_check
  CHECK (status IN ('reserved','submitting','submitted','confirmed','reverted','unknown','cancelled'));

ALTER TABLE execution_withdrawal_reservations
  ADD COLUMN IF NOT EXISTS source_address TEXT,
  ADD COLUMN IF NOT EXISTS submission_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS settlement_actual_amount NUMERIC(78,0)
    CHECK (settlement_actual_amount IS NULL OR settlement_actual_amount >= 0),
  ADD COLUMN IF NOT EXISTS settlement_gas_wei NUMERIC(78,0)
    CHECK (settlement_gas_wei IS NULL OR settlement_gas_wei >= 0),
  ADD COLUMN IF NOT EXISTS settlement_status TEXT
    CHECK (settlement_status IS NULL OR settlement_status IN ('confirmed','reverted')),
  ADD COLUMN IF NOT EXISTS settlement_evidence JSONB,
  ADD COLUMN IF NOT EXISTS settlement_verified_at TIMESTAMPTZ;

ALTER TABLE execution_withdrawal_reservations
  DROP CONSTRAINT IF EXISTS execution_withdrawal_source_address_check,
  DROP CONSTRAINT IF EXISTS execution_withdrawal_nonce_nonnegative_check,
  DROP CONSTRAINT IF EXISTS execution_withdrawal_settlement_evidence_check;
ALTER TABLE execution_withdrawal_reservations
  ADD CONSTRAINT execution_withdrawal_source_address_check
    CHECK (source_address IS NULL OR source_address ~ '^0x[0-9a-fA-F]{40}

ALTER TABLE execution_withdrawal_audit_events
  DROP CONSTRAINT IF EXISTS execution_withdrawal_audit_events_to_status_check;
ALTER TABLE execution_withdrawal_audit_events
  ADD CONSTRAINT execution_withdrawal_audit_events_to_status_check
  CHECK (to_status IN ('reserved','submitting','submitted','confirmed','reverted','unknown','cancelled'));

CREATE INDEX IF NOT EXISTS execution_withdrawal_pending_reconciliation_idx
  ON execution_withdrawal_reservations(status, updated_at)
  WHERE status IN ('submitting','submitted','unknown');
),
  ADD CONSTRAINT execution_withdrawal_nonce_nonnegative_check
    CHECK (nonce IS NULL OR nonce >= 0),
  ADD CONSTRAINT execution_withdrawal_settlement_evidence_check
    CHECK (settlement_status IS NULL OR (
      settlement_status = status AND settlement_evidence IS NOT NULL AND settlement_verified_at IS NOT NULL
      AND confirmation_block IS NOT NULL AND confirmation_block_hash IS NOT NULL AND transaction_hash IS NOT NULL
    ));

ALTER TABLE execution_withdrawal_audit_events
  DROP CONSTRAINT IF EXISTS execution_withdrawal_audit_events_to_status_check;
ALTER TABLE execution_withdrawal_audit_events
  ADD CONSTRAINT execution_withdrawal_audit_events_to_status_check
  CHECK (to_status IN ('reserved','submitting','submitted','confirmed','reverted','unknown','cancelled'));

CREATE INDEX IF NOT EXISTS execution_withdrawal_pending_reconciliation_idx
  ON execution_withdrawal_reservations(status, updated_at)
  WHERE status IN ('submitting','submitted','unknown');
