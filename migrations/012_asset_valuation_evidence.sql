-- Phase 2.4J: immutable provenance for verified asset valuations.
CREATE TABLE IF NOT EXISTS execution_asset_valuation_evidence (
  account_id TEXT NOT NULL,
  asset_address TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  chain_id INTEGER NOT NULL CHECK (chain_id = 137),
  block_number NUMERIC(78,0) NOT NULL CHECK (block_number >= 0),
  block_hash TEXT NOT NULL CHECK (block_hash ~ '^0x[0-9a-fA-F]{64}$'),
  asset_feed_address TEXT NOT NULL CHECK (asset_feed_address ~ '^0x[0-9a-fA-F]{40}$'),
  quote_feed_address TEXT NOT NULL CHECK (quote_feed_address ~ '^0x[0-9a-fA-F]{40}$'),
  asset_round_id NUMERIC(78,0) NOT NULL CHECK (asset_round_id > 0),
  quote_round_id NUMERIC(78,0) NOT NULL CHECK (quote_round_id > 0),
  asset_answer NUMERIC(78,0) NOT NULL CHECK (asset_answer > 0),
  quote_answer NUMERIC(78,0) NOT NULL CHECK (quote_answer > 0),
  asset_feed_decimals SMALLINT NOT NULL CHECK (asset_feed_decimals BETWEEN 0 AND 36),
  quote_feed_decimals SMALLINT NOT NULL CHECK (quote_feed_decimals BETWEEN 0 AND 36),
  confirmations INTEGER NOT NULL CHECK (confirmations >= 64),
  required_confirmations INTEGER NOT NULL CHECK (required_confirmations >= 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(account_id,asset_address,observed_at),
  FOREIGN KEY(account_id,asset_address,observed_at)
    REFERENCES execution_asset_valuations(account_id,asset_address,observed_at) ON DELETE CASCADE
);
