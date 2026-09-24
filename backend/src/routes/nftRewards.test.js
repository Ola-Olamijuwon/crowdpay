const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ queryImpl, nftServiceOverrides = {} }) {
  const router = proxyquire('./nftRewards', {
    '../config/database': { query: queryImpl },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'user-1' };
        next();
      },
    },
    '../services/nftRewardService': {
      getUserNftRewards: async () => [],
      getCampaignNftRewards: async () => [],
      listNftRewardsForContribution: async () => [],
      ensureNftRewardRecord: async () => ({ id: 'nft-1', status: 'minting' }),
      markNftRewardFailed: async () => {},
      markNftRewardMinted: async () => {
        throw new Error('should not mint mocks');
      },
      isNftMintConfigured: () => false,
      assertContributionOwnedByUser: async (contributionId, _userId) => {
        if (contributionId === 'missing') {
          const err = new Error('Contribution not found');
          err.statusCode = 404;
          throw err;
        }
        if (contributionId === 'other-user') {
          const err = new Error('Forbidden');
          err.statusCode = 403;
          throw err;
        }
        return {
          id: contributionId,
          campaign_id: 'camp-1',
          sender_public_key: 'GTEST',
        };
      },
      ...nftServiceOverrides,
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/nft-rewards', router);
  return app;
}

test('POST /api/nft-rewards/claim rejects claim for another users contribution (#815)', async () => {
  const app = buildApp({
    queryImpl: async () => ({ rows: [] }),
  });

  const res = await request(app)
    .post('/api/nft-rewards/claim')
    .send({
      campaign_id: 'camp-1',
      reward_tier_id: 'tier-1',
      contribution_id: 'other-user',
    });

  assert.equal(res.status, 403);
});

test('POST /api/nft-rewards/claim fails closed when NFT contract is not configured (#815)', async () => {
  const app = buildApp({
    queryImpl: async (text) => {
      if (text.includes('FROM reward_tiers')) {
        return { rows: [{ id: 'tier-1', campaign_id: 'camp-1', nft_enabled: true }] };
      }
      if (text.includes('FROM nft_rewards')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  const res = await request(app)
    .post('/api/nft-rewards/claim')
    .send({
      campaign_id: 'camp-1',
      reward_tier_id: 'tier-1',
      contribution_id: 'contrib-1',
    });

  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'NFT_MINT_UNAVAILABLE');
  assert.ok(!res.body.token_id);
  assert.ok(!String(res.body.token_id || '').startsWith('tok_'));
});

test('POST /api/nft-rewards/claim rejects campaign mismatch (#815)', async () => {
  const app = buildApp({
    queryImpl: async () => ({ rows: [] }),
  });

  const res = await request(app)
    .post('/api/nft-rewards/claim')
    .send({
      campaign_id: 'camp-OTHER',
      reward_tier_id: 'tier-1',
      contribution_id: 'contrib-1',
    });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /does not belong to the requested campaign/);
});
