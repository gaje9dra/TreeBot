-- Phase 2.4H: proof-bearing trade settlement and authoritative token inventory.
ALTER TABLE execution_transactions
  ADD COLUMN IF NOT EXISTS confirmation_block_hash TEXT,
  ADD COLUMN IF NOT EXISTS settlement_status TEXT
    CHECK (settlement_status IS NULL OR settlement_status IN ('confirmed','reverted')),
  ADD COLUMN IF NOT EXISTS settlement_evidence JSONB,
  ADD COLUMN IF NOT EXISTS settlement_verified_at TIMESTAMPTZ;

ALTER TABLE execution_transactions
  DROP CONSTRAINT IF EXISTS execution_transactions_settlement_evidence_check;
ALTER TABLE execution_transactions
  ADD CONSTRAINT execution_transactions_settlement_evidence_check
  CHECK (settlement_status IS NULL OR (
    settlement_status = status AND settlement_evidence IS NOT NULL AND settlement_verified_at IS NOT NULL
    AND confirmation_block IS NOT NULL AND confirmation_block_hash IS NOT NULL AND tx_hash IS NOT NULL
  ));

ALTER TABLE execution_open_positions
  ADD COLUMN IF NOT EXISTS cost_basis_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (cost_basis_status IN ('pending','complete','reconciliation_required'));

CREATE TABLE IF NOT EXISTS execution_position_inventory (
  chain_id INTEGER NOT NULL CHECK (chain_id = 137),
  account_id TEXT NOT NULL,
  asset_address TEXT NOT NULL CHECK (asset_address ~ '^0x[0-9a-fA-F]{40}$'),
  quantity_base_units NUMERIC(78,0) NOT NULL CHECK (quantity_base_units >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(chain_id, account_id, asset_address)
);
CREATE INDEX IF NOT EXISTS execution_position_inventory_account_idx
  ON execution_position_inventory(account_id, asset_address);

-- Backfill the quantity mirror from the existing authoritative journal only.
-- Negative balances are intentionally not materialized and must be reconciled before spending.
INSERT INTO execution_position_inventory(chain_id,account_id,asset_address,quantity_base_units,updated_at)
SELECT 137,account_id,LOWER(asset_address),SUM(amount_base_units)::numeric,NOW()
FROM execution_ledger_entries
WHERE LOWER(asset_address) <> '0x0000000000000000000000000000000000000000' AND entry_type <> 'realized_pnl'
GROUP BY account_id,LOWER(asset_address)
HAVING SUM(amount_base_units) > 0
ON CONFLICT(chain_id,account_id,asset_address) DO NOTHING;

INSERT INTO execution_open_positions(account_id,asset_address,quantity_base_units,cost_basis_quote_base_units,quote_asset_address,updated_at,cost_basis_status)
SELECT account_id,asset_address,quantity_base_units,0,'0x0000000000000000000000000000000000000000',NOW(),'pending'
FROM execution_position_inventory
ON CONFLICT(account_id,asset_address,quote_asset_address) DO UPDATE SET
  quantity_base_units=EXCLUDED.quantity_base_units,
  cost_basis_status='pending',
  updated_at=NOW();

CREATE TABLE IF NOT EXISTS execution_portfolio_reconciliation (
  id BIGSERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL CHECK (chain_id = 137),
  account_id TEXT NOT NULL,
  asset_address TEXT NOT NULL,
  ledger_balance NUMERIC(78,0) NOT NULL,
  inventory_quantity NUMERIC(78,0) NOT NULL,
  discrepancy NUMERIC(79,0) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('matched','mismatch')),
  reconciled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS execution_portfolio_reconciliation_latest_idx
  ON execution_portfolio_reconciliation(account_id,asset_address,reconciled_at DESC);
