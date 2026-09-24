const { insertContributionSubmitted } = require('./stellarTransactionService');
const { withDecryptedWalletSecret } = require('./walletSecrets');
const {
  prepareSignedContributionPayment,
  prepareSignedContributionPathPayment,
  submitPreparedTransaction,
  getPathPaymentQuote,
  ensureCustodialAccountFundedAndTrusted,
} = require('./stellarService');
const { depositToEscrow, isContractDepositEligible } = require('./sorobanService');
const { SLIPPAGE_BPS, STELLAR_ASSET_DECIMALS_SCALE } = require('../config/constants');
const { buildReferralMemo } = require('./referral');

const CONTRACT_MODE_CROSS_ASSET_MESSAGE = (assetType) =>
  `Cross-asset contributions aren't supported for this campaign's contract-backed treasury yet — please contribute in ${assetType} directly.`;

function buildContributionMemo(campaignId) {
  return `cp-${String(campaignId).replace(/-/g, '').slice(0, 25)}`.slice(0, 28);
}

/**
 * A referred contribution carries `ref:<code>` instead of the campaign memo, so
 * attribution is recorded on-chain and stays verifiable from Horizon (#675).
 */
function buildAttributionMemo(campaignId, referralCode) {
  return referralCode ? buildReferralMemo(referralCode) : buildContributionMemo(campaignId);
}

async function buildContributionIntent({
  campaign,
  amount,
  sendAsset,
  contributorPublicKey,
  displayName,
}) {
  if (sendAsset === campaign.asset_type) {
    return {
      kind: 'payment',
      conversionQuote: null,
      flowMetadata: {
        flow: 'payment',
        send_asset: sendAsset,
        amount: String(amount),
        contributor_public_key: contributorPublicKey,
        display_name: displayName || null,
      },
    };
  }

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

  const bestPath = paths[0];
  const sendMax = (
    parseFloat(bestPath.source_amount) *
    (1 + SLIPPAGE_BPS / 10000)
  ).toFixed(7);

  return {
    kind: 'path_payment_strict_receive',
    sendMax,
    conversionQuote: {
      send_asset: sendAsset,
      campaign_asset: campaign.asset_type,
      campaign_amount: String(amount),
      quoted_source_amount: bestPath.source_amount,
      max_send_amount: sendMax,
      path: bestPath.path,
    },
    flowMetadata: {
      flow: 'path_payment_strict_receive',
      send_asset: sendAsset,
      dest_asset: campaign.asset_type,
      dest_amount: String(amount),
      max_send_amount: sendMax,
      contributor_public_key: contributorPublicKey,
      display_name: displayName || null,
    },
  };
}

async function submitCustodialContribution({
  campaign,
  campaignId,
  userId,
  walletPublicKey,
  walletSecretEncrypted,
  amount,
  sendAsset,
  intentOverride,
  anchorMetadata,
  displayName,
  referralCode,
  referralLinkCode,
  referralLinkId,
  ipAddress,
  deviceFingerprint,
  client,
  tierId,
}) {
  const contractMode = isContractDepositEligible(campaign);
  if (contractMode && sendAsset !== campaign.asset_type) {
    const error = new Error(CONTRACT_MODE_CROSS_ASSET_MESSAGE(campaign.asset_type));
    error.statusCode = 422;
    throw error;
  }

  const intent =
    intentOverride ||
    (await buildContributionIntent({
      campaign,
      amount,
      sendAsset,
      contributorPublicKey: walletPublicKey,
      displayName,
    }));

  let unsignedXdr = null;
  let signedXdr = null;
  let platformFeeAmount = 0;
  let txHash;

  if (contractMode) {
    // Same-asset only (see issue #710) — deposit directly into the escrow
    // contract, self-authorized by the custodial account's own key, instead
    // of paying the classic campaign wallet.
    const depositResult = await withDecryptedWalletSecret(
      walletSecretEncrypted,
      { userId, walletPublicKey },
      async (senderSecret) => {
        await ensureCustodialAccountFundedAndTrusted({
          publicKey: walletPublicKey,
          secret: senderSecret,
        });
        return depositToEscrow({
          contractId: campaign.escrow_contract_id,
          fromAddress: walletPublicKey,
          amount: Math.floor(parseFloat(amount) * STELLAR_ASSET_DECIMALS_SCALE),
          signerSecret: senderSecret,
        });
      }
    );
    txHash = depositResult.txHash;
  } else {
    const preparedTransaction = await withDecryptedWalletSecret(
      walletSecretEncrypted,
      {
        userId,
        walletPublicKey,
      },
      async (senderSecret) => {
        await ensureCustodialAccountFundedAndTrusted({
          publicKey: walletPublicKey,
          secret: senderSecret,
        });

        if (intent.kind === 'payment') {
          return prepareSignedContributionPayment({
            senderSecret,
            destinationPublicKey: campaign.wallet_public_key,
            asset: sendAsset,
            amount,
            memo: buildAttributionMemo(campaignId, referralLinkCode),
          });
        }

        return prepareSignedContributionPathPayment({
          senderSecret,
          destinationPublicKey: campaign.wallet_public_key,
          sendAsset,
          sendMax: intent.sendMax,
          destAmount: amount,
          destAssetCode: campaign.asset_type,
          memo: buildAttributionMemo(campaignId, referralLinkCode),
        });
      }
    );

    unsignedXdr = preparedTransaction.unsignedXdr;
    signedXdr = preparedTransaction.signedXdr;
    platformFeeAmount = preparedTransaction.feeAmount ?? 0;
    try {
      txHash = await submitPreparedTransaction(signedXdr);
    } catch (err) {
      err.statusCode = err.statusCode || 502;
      throw err;
    }
  }

  const metadata = {
    ...intent.flowMetadata,
    platform_fee_amount: platformFeeAmount,
    ip_address: ipAddress || null,
    device_fingerprint: deviceFingerprint || null,
    tier_id: tierId || null,
    nft_reward: Boolean(tierId),
    contract_mode: contractMode,
    ...(referralCode ? { referral_code: referralCode } : {}),
    ...(referralLinkId ? { referral_link_id: referralLinkId, referral_link_code: referralLinkCode } : {}),
    ...(anchorMetadata
      ? {
          anchor: {
            anchor_id: anchorMetadata.anchor_id,
            anchor_transaction_id: anchorMetadata.anchor_transaction_id,
            anchor_asset: anchorMetadata.anchor_asset,
            anchor_amount: anchorMetadata.anchor_amount,
            anchor_deposit_id: anchorMetadata.anchor_deposit_id,
          },
        }
      : {}),
  };

  const stellarTransactionId = await insertContributionSubmitted(client, {
    txHash,
    campaignId,
    userId,
    unsignedXdr,
    signedXdr,
    metadata,
  });

  return {
    txHash,
    stellarTransactionId,
    unsignedXdr,
    signedXdr,
    conversionQuote: intent.conversionQuote,
    flowMetadata: metadata,
    contractMode,
    platformFeeAmount,
    platform_fee_amount: platformFeeAmount,
    destinationAmount: parseFloat(amount),
    destinationAsset: campaign.asset_type,
  };
}

module.exports = {
  buildAttributionMemo,
  buildContributionIntent,
  buildContributionMemo,
  submitCustodialContribution,
  CONTRACT_MODE_CROSS_ASSET_MESSAGE,
};
