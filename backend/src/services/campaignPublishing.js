const db = require('../config/database');
const logger = require('../config/logger');
const { Keypair } = require('@stellar/stellar-sdk');
const { createCampaignWallet } = require('./stellarService');
const { deployCampaignContracts } = require('./sorobanService');
const { watchCampaignWallet } = require('./ledgerMonitor');
const { STELLAR_ASSET_DECIMALS_SCALE } = require('../config/constants');

const MILESTONE_PERCENT_SCALE = 10000;

class CampaignNotPublishableError extends Error {}

/**
 * Deploys the on-chain wallet + Soroban contracts for a draft campaign and
 * flips it to 'active'. Shared by the manual POST /:id/publish route and the
 * scheduled-publish cron so both call sites stay in sync.
 */
async function publishDraftCampaign(campaignId) {
  const { rows: campaigns } = await db.query(
    'SELECT id, title, target_amount, asset_type, deadline, creator_id, status FROM campaigns WHERE id = $1',
    [campaignId]
  );
  if (!campaigns.length || campaigns[0].status !== 'draft') {
    throw new CampaignNotPublishableError('Campaign not found or is not a draft');
  }
  const campaign = campaigns[0];

  const { rows: users } = await db.query('SELECT wallet_public_key FROM users WHERE id = $1', [
    campaign.creator_id,
  ]);
  const creatorPublicKey = users[0]?.wallet_public_key;
  if (!creatorPublicKey) {
    throw new CampaignNotPublishableError('Campaign creator has no wallet configured');
  }

  const { rows: milestoneRows } = await db.query(
    'SELECT title, description, release_percentage, sort_order FROM milestones WHERE campaign_id = $1 ORDER BY sort_order ASC',
    [campaignId]
  );
  const milestones = milestoneRows.map((m) => ({
    title: m.title,
    description: m.description,
    release_percentage: Number(m.release_percentage).toFixed(4),
    release_percentage_units: Math.round(Number(m.release_percentage) * MILESTONE_PERCENT_SCALE),
    sort_order: m.sort_order,
  }));

  const wallet = await createCampaignWallet(creatorPublicKey);

  const platformPublicKey = Keypair.fromSecret(process.env.PLATFORM_SECRET_KEY).publicKey();
  const platformFeeBps = parseInt(process.env.PLATFORM_FEE_BPS || '0', 10);
  const deadlineUnix = campaign.deadline ? Math.floor(new Date(campaign.deadline).getTime() / 1000) : 0;
  const assetContractAddress = process.env.USDC_CONTRACT_ADDRESS || process.env.USDC_ISSUER;

  const { escrowContractId, milestonesContractId } = await deployCampaignContracts({
    creatorPublicKey,
    platformPublicKey,
    campaignId: campaign.title + Date.now(),
    targetAmount: Math.floor(parseFloat(campaign.target_amount) * STELLAR_ASSET_DECIMALS_SCALE),
    deadlineUnix,
    assetContractAddress,
    platformFeeBps,
    milestones,
    signerSecret: process.env.PLATFORM_SECRET_KEY,
  });

  // When Soroban is enabled, refuse to activate without verified contract IDs.
  if (
    process.env.SOROBAN_ENABLED === 'true' &&
    (!escrowContractId || !milestonesContractId)
  ) {
    throw new CampaignNotPublishableError(
      'Soroban is enabled but campaign contract deployment returned no contract IDs'
    );
  }

  const { rows: updated } = await db.query(
    `UPDATE campaigns
     SET wallet_public_key = $1, escrow_contract_id = $2, milestones_contract_id = $3,
         contract_address = $2, contract_deployed_at = NOW(), platform_fee_bps = $4,
         status = 'active', scheduled_publish_at = NULL,
         contract_deployment_status = 'deployed', contract_deployment_error = NULL,
         last_deployment_attempt_at = NOW()
     WHERE id = $5 AND status = 'draft'
     RETURNING *`,
    [wallet.publicKey, escrowContractId, milestonesContractId, platformFeeBps, campaignId]
  );

  if (!updated.length) {
    logger.error('[campaignPublishing] Campaign status changed during publish. Orphaned wallet:', {
      publicKey: wallet.publicKey,
      campaignId,
    });
    throw new CampaignNotPublishableError('Campaign is no longer a draft');
  }

  watchCampaignWallet(updated[0].id, wallet.publicKey);

  return updated[0];
}

module.exports = {
  CampaignNotPublishableError,
  publishDraftCampaign,
};
