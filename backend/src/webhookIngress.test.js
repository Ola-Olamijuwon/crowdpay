const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

// Load the real, full Express app (index.js) with ONLY the database layer
// stubbed. The whole middleware chain runs for real so this proves the
// webhook ingress ordering (#799): signatures are verified against a *raw*
// body (the global express.json must not consume it first), the Persona KYC
// callback is wired at the documented /api/webhooks/kyc path, and
// non-POST probes are rejected with 405 + Allow.
process.env.PERSONA_WEBHOOK_SECRET = 'whsec_test';
process.env.NODE_ENV = 'test';

const dbPath = require.resolve('../config/database');
const dbStub = {
  query: async (sql, params = []) => {
    if (sql.includes('UPDATE users')) {
      const [kycStatus] = params;
      return {
        rows: [
          {
            id: 'user-1',
            email: null,
            name: 'User',
            kyc_status: kycStatus,
            kyc_completed_at: kycStatus === 'verified' ? new Date().toISOString() : null,
            verification_status: kycStatus === 'verified' ? 'approved' : 'declined',
            verification_tier: 'basic',
            wallet_public_key: null,
          },
        ],
      };
    }
    if (sql.includes('FROM webhooks WHERE id')) {
      return { rows: [{ id: 'wh-1', user_id: 'owner-1', secret: 'whsec_test' }] };
    }
    return { rows: [] };
  },
  getPoolMetrics: () => ({ total: 1, idle: 1, waiting: 0, max: 1, utilisation: 0 }),
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };

const app = require('../index');

function personaSignature(rawBody) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = crypto
    .createHmac('sha256', 'whsec_test')
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

function webhookSignature(rawBody) {
  return `sha256=${crypto.createHmac('sha256', 'whsec_test').update(rawBody).digest('hex')}`;
}

const kycPayload = JSON.stringify({
  data: {
    attributes: {
      name: 'inquiry.approved',
      payload: {
        data: {
          id: 'inq_123',
          attributes: {
            status: 'approved',
            'reference-id': 'user-1',
          },
        },
      },
    },
  },
});

let server;
let base;

test('POST /api/webhooks/kyc accepts a valid Persona signature over the raw body', async () => {
  process.env.PERSONA_WEBHOOK_SECRET = 'whsec_test';
  const res = await request(app)
    .post('/api/webhooks/kyc')
    .set('content-type', 'application/json')
    .set('persona-signature', personaSignature(kycPayload))
    .send(kycPayload);
  assert.equal(res.status, 200);
  assert.equal(res.body.received, true);
});

test('POST /api/webhooks/kyc rejects a tampered payload (body/signature mismatch)', async () => {
  const res = await request(app)
    .post('/api/webhooks/kyc')
    .set('content-type', 'application/json')
    .set('persona-signature', personaSignature(kycPayload))
    .send(kycPayload.replace('inq_123', 'inq_EVIL'));
  assert.equal(res.status, 401);
  assert.match(res.body.error, /signature/i);
});

test('POST /api/webhooks/kyc rejects a request with no signature', async () => {
  const res = await request(app)
    .post('/api/webhooks/kyc')
    .set('content-type', 'application/json')
    .send(kycPayload);
  assert.equal(res.status, 401);
});

test('GET /api/webhooks/kyc is rejected with 405 + Allow: POST', async () => {
  const res = await request(app).get('/api/webhooks/kyc');
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'POST');
});

test('POST /api/webhooks/kyc is no longer served at the legacy /api/kyc-webhook path', async () => {
  const res = await request(app)
    .post('/api/kyc-webhook')
    .set('content-type', 'application/json')
    .send(kycPayload);
  assert.equal(res.status, 404);
});

test('POST /api/webhooks/incoming/:id verifies its raw-body signature before processing', async () => {
  const raw = JSON.stringify({ type: 'contribution.confirmed', contribution: { tx_hash: 'tx-1' } });
  const res = await request(app)
    .post('/api/webhooks/incoming/wh-1')
    .set('content-type', 'application/json')
    .set('x-signature-256', webhookSignature(raw))
    .send(raw);
  // Signature passed (not 401); the unsupported event type is rejected by the
  // dispatcher, proving the ingress (raw body + HMAC) ran end to end.
  assert.equal(res.status, 400);
  assert.match(res.body.error, /unsupported webhook event type/i);
});

test('POST /api/webhooks/incoming/:id rejects a bad signature', async () => {
  const raw = JSON.stringify({ type: 'contribution.confirmed', contribution: { tx_hash: 'tx-1' } });
  const res = await request(app)
    .post('/api/webhooks/incoming/wh-1')
    .set('content-type', 'application/json')
    .set('x-signature-256', 'sha256=deadbeef')
    .send(raw);
  assert.equal(res.status, 401);
});

test('GET /api/webhooks/incoming/:id is rejected with 405 + Allow: POST', async () => {
  const res = await request(app).get('/api/webhooks/incoming/wh-1');
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'POST');
});