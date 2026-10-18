-- Phase 2.4C: scanner ownership and durable reorg recovery metadata.
-- Observed chain events are not spendable credits. Recovery freezes credited orphan events.
ALTER TABLE execution_deposit_lifecycle
  ADD COLUMN IF NOT EXISTS watcher_key TEXT NOT NULL DEFAULT 'vault-main';

CREATE INDEX IF NOT EXISTS execution_deposit_lifecycle_watcher_block_idx
  ON execution_deposit_lifecycle(chain_id, watcher_key, block_number);
