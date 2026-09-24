const db = require('../config/database');

function isNftMintConfigured() {
  return Boolean(
    process.env.NFT_REWARDS_CONTRACT_ID &&
      process.env.NFT_REWARDS_ENABLED === 'true'
  );
}

async function assertContributionOwnedByUser(contributionId, userId) {
  const { rows } = await db.query(
    `SELECT c.id, c.campaign_id, c.sender_public_key, c.amount, c.status
     FROM contributions c
     JOIN users u ON u.wallet_public_key = c.sender_public_key
     WHERE c.id = $1 AND u.id = $2`,
    [contributionId, userId]
  );
  if (!rows.length) {
    const { rows: exists } = await db.query(
      `SELECT id FROM contributions WHERE id = $1`,
      [contributionId]
    );
    const err = new Error(exists.length ? 'Forbidden' : 'Contribution not found');
    err.statusCode = exists.length ? 403 : 404;
    throw err;
  }
  return rows[0];
}

async function getUserNftRewards(userId) {
  const { rows } = await db.query(
    `SELECT nr.id, nr.status, nr.metadata_url, nr.artwork_url, nr.token_id, nr.tx_hash, nr.serial_number, nr.created_at,
            c.id AS campaign_id, c.title AS campaign_title,
            rt.id AS reward_tier_id, rt.title AS reward_tier_title,
            ctr.id AS contribution_id
     FROM nft_rewards nr
     JOIN campaigns c ON c.id = nr.campaign_id
     LEFT JOIN reward_tiers rt ON rt.id = nr.reward_tier_id
     LEFT JOIN contributions ctr ON ctr.id = nr.contribution_id
     LEFT JOIN users u ON u.wallet_public_key = ctr.sender_public_key
     WHERE (u.id = $1 OR EXISTS (
       SELECT 1 FROM contributions ctr2
       JOIN users u2 ON u2.wallet_public_key = ctr2.sender_public_key
       WHERE ctr2.id = ctr.id AND u2.id = $1
     ))
       AND nr.status <> 'quarantined'
     ORDER BY nr.created_at DESC`,
    [userId],
  );
  return rows;
}

async function getCampaignNftRewards(campaignId) {
  const { rows } = await db.query(
    `SELECT nr.id, nr.status, nr.metadata_url, nr.artwork_url, nr.token_id, nr.tx_hash, nr.serial_number,
            nr.created_at, nr.updated_at, nr.reward_tier_id, nr.contribution_id,
            rt.title AS reward_tier_title,
            ctr.sender_public_key AS contributor_public_key
     FROM nft_rewards nr
     JOIN reward_tiers rt ON rt.id = nr.reward_tier_id
     LEFT JOIN contributions ctr ON ctr.id = nr.contribution_id
     WHERE nr.campaign_id = $1
       AND nr.status <> 'quarantined'
     ORDER BY nr.created_at DESC`,
    [campaignId],
  );
  return rows;
}

async function markNftRewardMinted({
  rewardTierId,
  contributionId,
  tokenId,
  txHash,
  serialNumber,
  contractId = null,
}) {
  if (!tokenId || !txHash || String(tokenId).startsWith('tok_') || String(txHash).startsWith('hash_')) {
    throw new Error('Refusing to mark NFT as minted with mock identifiers');
  }
  await db.query(
    `UPDATE nft_rewards
     SET status = 'minted', token_id = $1, tx_hash = $2, serial_number = $3,
         contract_id = COALESCE($6, contract_id), updated_at = NOW()
     WHERE reward_tier_id = $4 AND contribution_id = $5`,
    [tokenId, txHash, serialNumber, rewardTierId, contributionId, contractId],
  );
}

async function markNftRewardFailed({ rewardTierId, contributionId, errorMessage }) {
  await db.query(
    `UPDATE nft_rewards
     SET status = 'failed', error_message = $1, updated_at = NOW()
     WHERE reward_tier_id = $2 AND contribution_id = $3`,
    [errorMessage, rewardTierId, contributionId],
  );
}

async function ensureNftRewardRecord({ campaignId, rewardTierId, contributionId }) {
  const { rows } = await db.query(
    `INSERT INTO nft_rewards (campaign_id, reward_tier_id, contribution_id, status)
     VALUES ($1, $2, $3, 'minting')
     ON CONFLICT (reward_tier_id, contribution_id) DO NOTHING
     RETURNING id, status`,
    [campaignId, rewardTierId, contributionId],
  );
  return rows[0] || null;
}

async function listNftRewardsForContribution(contributionId) {
  const { rows } = await db.query(
    `SELECT nr.id, nr.status, nr.metadata_url, nr.artwork_url, nr.token_id, nr.tx_hash, nr.serial_number,
            nr.created_at, nr.updated_at, nr.reward_tier_id, rt.title AS reward_tier_title
     FROM nft_rewards nr
     LEFT JOIN reward_tiers rt ON rt.id = nr.reward_tier_id
     WHERE nr.contribution_id = $1
     ORDER BY nr.created_at DESC`,
    [contributionId],
  );
  return rows;
}

module.exports = {
  getUserNftRewards,
  getCampaignNftRewards,
  markNftRewardMinted,
  markNftRewardFailed,
  ensureNftRewardRecord,
  listNftRewardsForContribution,
  isNftMintConfigured,
  assertContributionOwnedByUser,
};
