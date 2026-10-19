-- Phase 2.4E: proof-bearing deposit credit provenance.
-- Does not enable production crediting or live execution; scanner configuration and
-- operator/security release gates remain mandatory.
ALTER TABLE execution_deposit_events
  ADD COLUMN IF NOT EXISTS block_hash TEXT,
  ADD COLUMN IF NOT EXISTS vault_address TEXT,
  ADD COLUMN IF NOT EXISTS token_decimals SMALLINT NOT NULL DEFAULT 18
    CHECK (token_decimals BETWEEN 0 AND 36),
  ADD COLUMN IF NOT EXISTS receipt_status TEXT NOT NULL DEFAULT 'success'
    CHECK (receipt_status = 'success');

ALTER TABLE execution_deposit_lifecycle
  ADD COLUMN IF NOT EXISTS token_decimals SMALLINT
    CHECK (token_decimals BETWEEN 0 AND 36);

CREATE INDEX IF NOT EXISTS execution_deposit_events_account_asset_idx
  ON execution_deposit_events(account_id, asset_address, confirmed_at DESC);

-- Financial journal rows are append-only. Corrections must be compensating entries
-- with a new event key and explicit audit provenance, never UPDATE/DELETE.
CREATE OR REPLACE FUNCTION treebot_prevent_financial_record_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; use a compensating journal entry', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS execution_ledger_entries_immutable_update ON execution_ledger_entries;
CREATE TRIGGER execution_ledger_entries_immutable_update
BEFORE UPDATE OR DELETE ON execution_ledger_entries
FOR EACH ROW EXECUTE FUNCTION treebot_prevent_financial_record_mutation();

DROP TRIGGER IF EXISTS execution_deposit_events_immutable ON execution_deposit_events;
CREATE TRIGGER execution_deposit_events_immutable
BEFORE UPDATE OR DELETE ON execution_deposit_events
FOR EACH ROW EXECUTE FUNCTION treebot_prevent_financial_record_mutation();
