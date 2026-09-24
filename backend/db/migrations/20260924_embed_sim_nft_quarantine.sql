-- #813: track simulated embed contributions separately from real payments
-- #815: quarantine mock NFT mint records and support contract_id

ALTER TABLE embed_contributions
  ADD COLUMN IF NOT EXISTS simulated BOOLEAN NOT NULL DEFAULT false;

UPDATE embed_contributions
SET simulated = true
WHERE stellar_tx_hash LIKE 'tx_%';

CREATE INDEX IF NOT EXISTS idx_embed_contributions_simulated
  ON embed_contributions (campaign_id)
  WHERE simulated = false;

-- Expand nft_rewards status for quarantine of historical mock mints
ALTER TABLE nft_rewards DROP CONSTRAINT IF EXISTS nft_rewards_status_check;
ALTER TABLE nft_rewards
  ADD CONSTRAINT nft_rewards_status_check
  CHECK (status IN ('configured', 'minting', 'minted', 'failed', 'quarantined'));

ALTER TABLE nft_rewards
  ADD COLUMN IF NOT EXISTS contract_id TEXT;

UPDATE nft_rewards
SET status = 'quarantined',
    error_message = COALESCE(error_message, 'Mock mint invalidated; awaiting real on-chain claim'),
    updated_at = NOW()
WHERE status = 'minted'
  AND token_id LIKE 'tok_%'
  AND tx_hash LIKE 'hash_%';
