/**
 * pathPaymentPreview.js
 *
 * Ranked path-payment previews for cross-asset contributions (#688).
 *
 * Contributors see ranked DEX routes (cheapest first) before they commit, and
 * submit a single-use preview token with the contribution. The token is bound
 * to the exact campaign / send asset / destination amount that was quoted so a
 * contributed transaction cannot silently run a different, worse route than
 * the one the contributor approved.
 */
const crypto = require('crypto');
const { getPathPaymentQuote } = require('./stellarService');
const { SLIPPAGE_BPS } = require('../config/constants');
const redis = require('../config/redis');
const logger = require('../config/logger');

const PREVIEW_TTL_SECONDS = 30;
const PREVIEW_KEY_PREFIX = 'cp:contribution-preview:';

/** Apply the configured slippage buffer to a quoted source amount. */
function computeMaxSendAmount(sourceAmount) {
  return (
    parseFloat(sourceAmount) *
    (1 + SLIPPAGE_BPS / 10000)
  ).toFixed(7);
}

/**
 * Rank quote records by source_amount (cheapest first) and annotate each with
 * its zero-based index and slippage-buffered max_send_amount.
 */
function rankAndAnnotatePaths(paths) {
  return paths
    .slice()
    .sort((a, b) => parseFloat(a.source_amount) - parseFloat(b.source_amount))
    .map((record, index) => ({
      index,
      source_asset: record.source_asset,
      destination_asset: record.destination_asset,
      destination_amount: record.destination_amount,
      source_amount: record.source_amount,
      max_send_amount: computeMaxSendAmount(record.source_amount),
      path: record.path,
    }));
}

/**
 * Quote a cross-asset contribution and stage a single-use preview token.
 * Throws 422 when no conversion path exists.
 */
async function createPathPaymentPreview({ campaign, sendAsset, amount }) {
  const paths = await getPathPaymentQuote({
    sendAsset,
    destAsset: campaign.asset_type,
    destAmount: amount,
  });
  if (!paths.length) {
    const error = new Error(`No conversion path found for ${sendAsset} -> ${campaign.asset_type}`);
    error.statusCode = 422;
    throw error;
  }

  const previewToken = crypto.randomBytes(24).toString('hex');
  const rankedPaths = rankAndAnnotatePaths(paths);
  const stored = {
    campaign_id: campaign.id,
    send_asset: sendAsset,
    dest_asset: campaign.asset_type,
    dest_amount: String(amount),
    ranked_paths: rankedPaths,
  };

  await redis.set(
    `${PREVIEW_KEY_PREFIX}${previewToken}`,
    JSON.stringify(stored),
    'EX',
    PREVIEW_TTL_SECONDS
  );

  logger.debug('Staged contribution path preview', {
    campaignId: campaign.id,
    sendAsset,
    destAmount: String(amount),
    previewToken,
  });

  return {
    preview_token: previewToken,
    ...stored,
  };
}

/**
 * Validate + redeem a preview token for the exact contribution being placed.
 * The token is single-use (deleted on successful redemption). Paths are ranked
 * and annotated, so any returned path already carries its own max_send_amount.
 */
async function consumeContributionPreview({ previewToken, campaignId, sendAsset, amount, selectedPathIndex }) {
  const key = `${PREVIEW_KEY_PREFIX}${previewToken}`;
  const raw = await redis.get(key);
  if (!raw) {
    const error = new Error('Contribution preview has expired — please refresh the quote');
    error.code = 'PREVIEW_EXPIRED';
    error.statusCode = 409;
    throw error;
  }

  let stored;
  try {
    stored = JSON.parse(raw);
  } catch (err) {
    const error = new Error('Invalid contribution preview');
    error.code = 'PREVIEW_INVALID';
    error.statusCode = 400;
    throw error;
  }

  if (
    stored.campaign_id !== campaignId ||
    stored.send_asset !== sendAsset ||
    stored.dest_amount !== String(amount)
  ) {
    const error = new Error('Contribution preview does not match the pending contribution');
    error.code = 'PREVIEW_MISMATCH';
    error.statusCode = 409;
    throw error;
  }

  await redis.del(key);

  const selected =
    (Array.isArray(stored.ranked_paths) &&
      stored.ranked_paths.find((p) => p.index === selectedPathIndex)) ||
    null;
  if (!selected) {
    const error = new Error('Selected path index is not part of this contribution preview');
    error.code = 'PREVIEW_PATH_INVALID';
    error.statusCode = 400;
    throw error;
  }

  return { ...selected, effective_rate: String(parseFloat(selected.source_amount) / parseFloat(selected.destination_amount)) };
}

module.exports = {
  computeMaxSendAmount,
  createPathPaymentPreview,
  consumeContributionPreview,
  PREVIEW_TTL_SECONDS,
  PREVIEW_KEY_PREFIX,
};