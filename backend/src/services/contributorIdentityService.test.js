const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, StrKey } = require('@stellar/stellar-sdk');
const proxyquire = require('proxyquire').noCallThru();

const originalContractId = process.env.CONTRIBUTOR_IDENTITY_CONTRACT_ID;
const originalPlatformSecret = process.env.PLATFORM_SECRET_KEY;

const TEST_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 2));
const TEST_PUBLIC = Keypair.random().publicKey();
const TEST_SECRET = Keypair.random().secret();

beforeEach(() => {
  process.env.CONTRIBUTOR_IDENTITY_CONTRACT_ID = TEST_CONTRACT_ID;
  process.env.PLATFORM_SECRET_KEY = TEST_SECRET;
});

afterEach(() => {
  if (originalContractId === undefined) delete process.env.CONTRIBUTOR_IDENTITY_CONTRACT_ID;
  else process.env.CONTRIBUTOR_IDENTITY_CONTRACT_ID = originalContractId;
  if (originalPlatformSecret === undefined) delete process.env.PLATFORM_SECRET_KEY;
  else process.env.PLATFORM_SECRET_KEY = originalPlatformSecret;
});

test('verifyAttestation fails closed when contract read throws (#814)', async () => {
  const service = proxyquire('./contributorIdentityService', {
    '../config/database': {
      query: async () => ({
        rows: [{ expires_at: null }],
      }),
    },
    '../config/stellar': {
      server: {
        loadAccount: async () => {
          throw new Error('RPC unavailable');
        },
        simulateTransaction: async () => {
          throw new Error('RPC unavailable');
        },
      },
      networkPassphrase: 'Test SDF Network ; September 2015',
    },
    '../config/logger': { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
  });

  const result = await service.verifyAttestation(TEST_PUBLIC, 'kyc_basic');
  assert.equal(result.verified, false);
  assert.equal(result.unavailable, true);
});

test('verifyAttestation returns unverified when DB has no on-chain tx hash (#814)', async () => {
  const service = proxyquire('./contributorIdentityService', {
    '../config/database': {
      query: async (sql) => {
        assert.ok(sql.includes('on_chain_tx_hash IS NOT NULL'));
        return { rows: [] };
      },
    },
    '../config/logger': { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
  });

  const result = await service.verifyAttestation(TEST_PUBLIC, 'kyc_basic');
  assert.equal(result.verified, false);
  assert.equal(result.expiresAt, null);
});
