const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const proxyquire = require('proxyquire').noCallThru();

const originalSecret = process.env.PERSONA_WEBHOOK_SECRET;
const originalEnv = process.env.NODE_ENV;
const originalProvider = process.env.KYC_PROVIDER;

beforeEach(() => {
  process.env.PERSONA_WEBHOOK_SECRET = 'test-webhook-secret';
  process.env.NODE_ENV = 'production';
  delete process.env.KYC_PROVIDER;
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.PERSONA_WEBHOOK_SECRET;
  else process.env.PERSONA_WEBHOOK_SECRET = originalSecret;
  process.env.NODE_ENV = originalEnv;
  if (originalProvider === undefined) delete process.env.KYC_PROVIDER;
  else process.env.KYC_PROVIDER = originalProvider;
});

function loadProvider() {
  return proxyquire('./kycProvider', {});
}

test('verifyPersonaWebhookSignature accepts valid Persona signature', () => {
  const { verifyPersonaWebhookSignature } = loadProvider();
  const rawBody = JSON.stringify({ data: { id: 'inq_123' } });
  const timestamp = '1700000000';
  const signature = crypto
    .createHmac('sha256', 'test-webhook-secret')
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  assert.strictEqual(
    verifyPersonaWebhookSignature(rawBody, `t=${timestamp},v1=${signature}`),
    true
  );
});

test('verifyPersonaWebhookSignature rejects invalid signature', () => {
  const { verifyPersonaWebhookSignature } = loadProvider();
  const rawBody = JSON.stringify({ data: { id: 'inq_123' } });
  assert.strictEqual(
    verifyPersonaWebhookSignature(rawBody, 't=1700000000,v1=deadbeef'),
    false
  );
});

test('verifyPersonaWebhookSignature allows unsigned webhooks in test mode without secret', () => {
  delete process.env.PERSONA_WEBHOOK_SECRET;
  process.env.NODE_ENV = 'test';
  const { verifyPersonaWebhookSignature } = loadProvider();
  assert.strictEqual(verifyPersonaWebhookSignature('{}', null), true);
});

test('createKycSession fails closed when Persona keys are missing (#814)', async () => {
  delete process.env.PERSONA_API_KEY;
  delete process.env.PERSONA_TEMPLATE_ID;
  process.env.KYC_PROVIDER = 'persona';
  const { createKycSession } = loadProvider();
  await assert.rejects(
    () => createKycSession({ user: { id: 'u1', name: 'Test', email: 't@example.com' } }),
    /Persona KYC is not configured/
  );
});

test('createKycSession allows explicit dev provider (#814)', async () => {
  process.env.KYC_PROVIDER = 'dev';
  const { createKycSession } = loadProvider();
  const session = await createKycSession({ user: { id: 'u1', name: 'Test', email: 't@example.com' } });
  assert.strictEqual(session.provider, 'dev');
  assert.ok(session.redirectUrl);
});

test('extractWebhookResult maps approved inquiry to verified', () => {
  const { extractWebhookResult } = loadProvider();
  const result = extractWebhookResult({
    data: {
      id: 'evt_1',
      attributes: {
        name: 'inquiry.approved',
        payload: {
          data: {
            id: 'inq_abc',
            attributes: {
              status: 'approved',
              'reference-id': 'user-1',
            },
          },
        },
      },
    },
  });

  assert.strictEqual(result.kycStatus, 'verified');
  assert.strictEqual(result.providerReference, 'inq_abc');
  assert.strictEqual(result.userId, 'user-1');
});

test('extractWebhookResult maps declined inquiry to rejected with reason', () => {
  const { extractWebhookResult } = loadProvider();
  const result = extractWebhookResult({
    data: {
      attributes: {
        name: 'inquiry.declined',
        payload: {
          data: {
            id: 'inq_declined',
            attributes: {
              status: 'declined',
              'decline-reason': 'Document unreadable',
            },
          },
        },
      },
    },
  });

  assert.strictEqual(result.kycStatus, 'rejected');
  assert.strictEqual(result.reason, 'Document unreadable');
});

test('extractWebhookResult returns approved status and basic tier for approved inquiry with government-id check', () => {
  const { extractWebhookResult } = loadProvider();
  const result = extractWebhookResult({
    data: {
      attributes: {
        name: 'inquiry.approved',
        payload: {
          data: {
            id: 'inq_gov',
            attributes: {
              status: 'approved',
              'reference-id': 'user-2',
              checks: [
                { type: 'government-id' },
              ],
            },
          },
        },
      },
    },
  });

  assert.strictEqual(result.verificationStatus, 'approved');
  assert.strictEqual(result.tier, 'basic');
});

test('extractWebhookResult returns enhanced tier for approved inquiry with government-id, address, and liveness checks', () => {
  const { extractWebhookResult } = loadProvider();
  const result = extractWebhookResult({
    data: {
      attributes: {
        name: 'inquiry.approved',
        payload: {
          data: {
            id: 'inq_enhanced',
            attributes: {
              status: 'approved',
              'reference-id': 'user-3',
              checks: [
                { type: 'government-id' },
                { type: 'address' },
                { type: 'liveness' },
              ],
            },
          },
        },
      },
    },
  });

  assert.strictEqual(result.verificationStatus, 'approved');
  assert.strictEqual(result.tier, 'enhanced');
});

test('extractWebhookResult returns standard tier for government-id and address checks without liveness', () => {
  const { extractWebhookResult } = loadProvider();
  const result = extractWebhookResult({
    data: {
      attributes: {
        name: 'inquiry.approved',
        payload: {
          data: {
            id: 'inq_std',
            attributes: {
              status: 'approved',
              'reference-id': 'user-4',
              checks: [
                { type: 'government-id' },
                { type: 'address' },
              ],
            },
          },
        },
      },
    },
  });

  assert.strictEqual(result.verificationStatus, 'approved');
  assert.strictEqual(result.tier, 'standard');
});

test('extractWebhookResult returns none tier for declined inquiry', () => {
  const { extractWebhookResult } = loadProvider();
  const result = extractWebhookResult({
    data: {
      attributes: {
        name: 'inquiry.declined',
        payload: {
          data: {
            id: 'inq_decl',
            attributes: {
              status: 'declined',
              'reference-id': 'user-5',
            },
          },
        },
      },
    },
  });

  assert.strictEqual(result.verificationStatus, 'declined');
  assert.strictEqual(result.tier, 'none');
});

test('getTierLimit returns correct limits for each tier', () => {
  const { getTierLimit } = loadProvider();
  assert.strictEqual(getTierLimit('none'), 0);
  assert.strictEqual(getTierLimit('basic'), 5000);
  assert.strictEqual(getTierLimit('standard'), 50000);
  assert.strictEqual(getTierLimit('enhanced'), Infinity);
});

test('determineVerificationTier returns basic for government-id check only', () => {
  const { determineVerificationTier } = loadProvider();
  const tier = determineVerificationTier({
    data: {
      attributes: {
        payload: {
          data: {
            attributes: {
              checks: [{ type: 'government-id' }],
            },
          },
        },
      },
    },
  });
  assert.strictEqual(tier, 'basic');
});

test('determineVerificationTier returns enhanced for liveness check', () => {
  const { determineVerificationTier } = loadProvider();
  const tier = determineVerificationTier({
    data: {
      attributes: {
        payload: {
          data: {
            attributes: {
              checks: [
                { type: 'government-id' },
                { type: 'address' },
                { type: 'liveness' },
              ],
            },
          },
        },
      },
    },
  });
  assert.strictEqual(tier, 'enhanced');
});
