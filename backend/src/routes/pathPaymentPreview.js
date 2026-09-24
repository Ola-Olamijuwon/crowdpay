const express = require('express');
const router = express.Router({ mergeParams: true });
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const db = require('../config/database');
const pathPaymentPreviewService = require('../services/pathPaymentPreview');

/**
 * POST /api/campaigns/:campaignId/contribution/preview
 *
 * Quote a cross-asset contribution and stage a ranked, single-use preview.
 * Same-asset contributions are answered immediately with `direct: true` and
 * skip the preview/quote round trip entirely (#688).
 */
router.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { campaignId } = req.params;
    const { send_asset, amount } = req.body;
    if (!send_asset || !amount) {
      return res.status(400).json({ error: 'send_asset and amount are required' });
    }

    const { rows } = await db.query(
      'SELECT id, asset_type, status FROM campaigns WHERE id = $1',
      [campaignId]
    );
    const campaign = rows[0];
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (campaign.status !== 'active') {
      return res.status(400).json({ error: 'Campaign is not active' });
    }

    if (send_asset === campaign.asset_type) {
      return res.json({
        direct: true,
        send_asset,
        dest_asset: campaign.asset_type,
        dest_amount: String(amount),
      });
    }

    const preview = await pathPaymentPreviewService.createPathPaymentPreview({
      campaign,
      sendAsset: send_asset,
      amount,
    });
    return res.json(preview);
  })
);

module.exports = router;