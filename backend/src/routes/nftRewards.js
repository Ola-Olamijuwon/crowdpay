const router = require('express').Router();
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const {
  getUserNftRewards,
  getCampaignNftRewards,
  listNftRewardsForContribution,
  ensureNftRewardRecord,
  markNftRewardFailed,
  isNftMintConfigured,
  assertContributionOwnedByUser,
} = require('../services/nftRewardService');

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const rewards = await getUserNftRewards(req.user.userId);
  res.json({ rewards });
}));

router.get('/campaign/:campaignId', asyncHandler(async (req, res) => {
  const rewards = await getCampaignNftRewards(req.params.campaignId);
  res.json({ rewards });
}));

router.get('/contributions/:contributionId', requireAuth, asyncHandler(async (req, res) => {
  try {
    await assertContributionOwnedByUser(req.params.contributionId, req.user.userId);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: 'Contribution not found' });
    if (err.statusCode === 403) return res.status(403).json({ error: 'Forbidden' });
    throw err;
  }
  const rewards = await listNftRewardsForContribution(req.params.contributionId);
  res.json({ rewards });
}));

router.post('/claim', requireAuth, asyncHandler(async (req, res) => {
  const { campaign_id, reward_tier_id, contribution_id } = req.body;

  if (!campaign_id || !reward_tier_id || !contribution_id) {
    return res.status(400).json({ error: 'campaign_id, reward_tier_id, and contribution_id are required' });
  }

  let contribution;
  try {
    contribution = await assertContributionOwnedByUser(contribution_id, req.user.userId);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: 'Contribution not found' });
    if (err.statusCode === 403) {
      return res.status(403).json({ error: 'You do not own this contribution' });
    }
    throw err;
  }

  if (contribution.campaign_id !== campaign_id) {
    return res.status(400).json({ error: 'Contribution does not belong to the requested campaign' });
  }

  const { rows: tierRows } = await db.query(
    `SELECT rt.id, rt.campaign_id,
            EXISTS (
              SELECT 1 FROM nft_rewards nr
              WHERE nr.reward_tier_id = rt.id AND nr.contribution_id IS NULL
            ) AS nft_enabled
     FROM reward_tiers rt
     WHERE rt.id = $1`,
    [reward_tier_id]
  );
  if (!tierRows.length) {
    return res.status(404).json({ error: 'Reward tier not found' });
  }
  if (tierRows[0].campaign_id !== campaign_id) {
    return res.status(400).json({ error: 'Reward tier does not belong to the requested campaign' });
  }
  if (!tierRows[0].nft_enabled) {
    return res.status(400).json({ error: 'Reward tier does not offer NFT rewards' });
  }

  if (!isNftMintConfigured()) {
    return res.status(503).json({
      error: 'NFT rewards unavailable until an NFT contract is configured',
      code: 'NFT_MINT_UNAVAILABLE',
    });
  }

  const { rows: existingRows } = await db.query(
    `SELECT id, status, token_id, tx_hash, serial_number, contract_id
     FROM nft_rewards
     WHERE reward_tier_id = $1 AND contribution_id = $2`,
    [reward_tier_id, contribution_id]
  );

  if (existingRows.length > 0) {
    const reward = existingRows[0];
    if (reward.status === 'minted') {
      return res.status(400).json({ error: 'NFT reward already claimed and minted', reward });
    }
    if (reward.status === 'quarantined') {
      return res.status(409).json({
        error: 'Previous mock mint was invalidated; reclaim once on-chain minting is available',
        reward,
      });
    }
    if (reward.status === 'minting') {
      return res.status(409).json({ error: 'NFT minting is already in progress', reward });
    }
  }

  const record = existingRows.length
    ? existingRows[0]
    : await ensureNftRewardRecord({
        campaignId: campaign_id,
        rewardTierId: reward_tier_id,
        contributionId: contribution_id,
      });

  if (!record) {
    const { rows: conflictRows } = await db.query(
      `SELECT id, status FROM nft_rewards WHERE reward_tier_id = $1 AND contribution_id = $2`,
      [reward_tier_id, contribution_id]
    );
    return res.status(409).json({ error: 'NFT reward claim already initiated', reward: conflictRows[0] });
  }

  // Contract is configured but no mint adapter is wired yet — leave as minting/failed,
  // never invent token IDs or tx hashes (#815).
  await markNftRewardFailed({
    rewardTierId: reward_tier_id,
    contributionId: contribution_id,
    errorMessage: 'On-chain NFT mint adapter is not implemented for the configured contract',
  });

  return res.status(503).json({
    error: 'NFT minting is configured but the on-chain mint adapter is not available yet',
    code: 'NFT_MINT_ADAPTER_UNAVAILABLE',
  });
}));

module.exports = router;
