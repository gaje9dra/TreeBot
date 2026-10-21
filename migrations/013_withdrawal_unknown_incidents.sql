-- Phase 2.4K: treat ambiguous withdrawal submission as a durable financial incident.
-- The affected account/source wallet and global execution path stay frozen until an
-- operator verifies the transaction outcome and resolves the incident/restrictions.
ALTER TABLE execution_financial_incidents
  DROP CONSTRAINT IF EXISTS execution_financial_incidents_incident_type_check;
ALTER TABLE execution_financial_incidents
  ADD CONSTRAINT execution_financial_incidents_incident_type_check
  CHECK (incident_type IN ('deposit_reorg_after_credit','ledger_mismatch','settlement_conflict'));
