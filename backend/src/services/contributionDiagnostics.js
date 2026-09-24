/**
 * contributionDiagnostics.js
 *
 * Live, actionable diagnostics for a contribution (#688). The ledger monitor
 * stamps a baseline `diagnosis` when a contribution confirms; this service
 * surfaces the on-chain truth by re-hydrating the transaction from Horizon and
 * computing the effective rate, actual route and slippage observed.
 */
const { server } = require('../config/stellar');
const logger = require('../config/logger');

const STATUS_PENDING = 'pending';
const STATUS_COMPLETED = 'completed';
const STATUS_FAILED = 'failed';

/** Returns { found, tx } where found=false when the tx is not on the ledger yet. */
async function fetchContributionTransaction(txHash) {
  try {
    const tx = await server.transactions().transaction(txHash).call();
    return { found: true, tx };
  } catch (err) {
    if (err?.response?.status === 404) {
      return { found: false, tx: null };
    }
    throw err;
  }
}

function assetLabel(asset) {
  if (!asset) return null;
  return asset.asset_type === 'native' ? 'XLM' : asset.asset_code || asset.asset_type;
}

/**
 * Build a report for a contribution. `contribution` is the persisted row
 * (may carry already-computed columns); `metadata` is the stellar_transactions
 * metadata captured at submit time. When Horizon is reachable this takes
 * precedence and reflects the transaction that actually ran.
 */
async function diagnoseContribution({ contribution = {}, metadata = {}, txHash = null }) {
  const report = {
    contribution_id: contribution.id || null,
    campaign_id: contribution.campaign_id || metadata.campaign_id || null,
    tx_hash: txHash || contribution.tx_hash || null,
    flow: metadata.flow || contribution.payment_type || 'payment',
    status: contribution.diagnosis || STATUS_PENDING,
    path_hops: contribution.path_hops ?? metadata.path_hops ?? null,
    effective_rate: contribution.effective_rate ?? metadata.effective_rate ?? null,
    allowed_slippage_bps: contribution.slippage_bps ?? metadata.slippage_bps ?? null,
    send_max: contribution.send_max ?? metadata.send_max ?? null,
    retry_count: contribution.retry_count ?? metadata.retry_count ?? 0,
  };

  const hash = report.tx_hash;
  if (!hash) {
    return report;
  }

  let found;
  let tx;
  try {
    ({ found, tx } = await fetchContributionTransaction(hash));
  } catch (err) {
    logger.warn('Contribution diagnosis: Horizon lookup failed', {
      txHash: hash,
      error: err.message,
    });
    const horizonError = new Error('Unable to reach Horizon for contribution diagnosis');
    horizonError.statusCode = 502;
    horizonError.horizonUnreachable = true;
    throw horizonError;
  }

  if (!found) {
    // Submission succeeded but the ledger has not confirmed it yet.
    report.status = report.status || STATUS_PENDING;
    report.on_ledger = false;
    return report;
  }

  const ops = Array.isArray(tx.operations) ? tx.operations : [];
  const pathOp = ops.find(
    (op) => op.type === 'path_payment_strict_receive' || op.type === 'path_payment_strict_send'
  );
  const paymentOp = ops.find((op) => op.type === 'payment');
  const targetOp = pathOp || paymentOp;

  report.on_ledger = true;
  report.status = tx.successful ? STATUS_COMPLETED : STATUS_FAILED;
  report.tx_successful = Boolean(tx.successful);
  report.ledger = tx.ledger || null;
  report.created_at = tx.created_at || null;

  if (pathOp) {
    report.path_hops = (pathOp.path || []).map(assetLabel);
    if (pathOp.source_amount && pathOp.destination_amount) {
      report.effective_rate = String(
        parseFloat(pathOp.source_amount) / parseFloat(pathOp.destination_amount)
      );
      report.source_amount = pathOp.source_amount;
      report.destination_amount = pathOp.destination_amount;
    }
  } else if (paymentOp) {
    report.path_hops = null;
    report.effective_rate = paymentOp.amount ? '1' : null;
    report.source_amount = paymentOp.amount || null;
    report.destination_amount = paymentOp.amount || null;
  }

  // Actual slippage vs the rate the contributor approved at quote time.
  const quotedSource = metadata.quoted_source_amount ?? metadata.max_send_amount;
  if (quotedSource && report.effective_rate) {
    const [src, dst] = [parseFloat(report.source_amount), parseFloat(report.destination_amount)];
    if (Number.isFinite(src) && Number.isFinite(dst) && dst > 0) {
      const actualRate = src / dst;
      const quotedRate = parseFloat(quotedSource) / parseFloat(metadata.dest_amount || dst || 1);
      if (Number.isFinite(quotedRate) && quotedRate > 0) {
        report.actual_slippage_bps = Math.max(
          0,
          Math.round(((actualRate - quotedRate) / quotedRate) * 10000)
        );
      }
    }
  }

  return report;
}

module.exports = {
  diagnoseContribution,
  STATUS_PENDING,
  STATUS_COMPLETED,
  STATUS_FAILED,
};