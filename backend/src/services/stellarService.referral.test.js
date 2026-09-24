const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire');
const { Asset, Keypair, Networks, TransactionBuilder } = require('@stellar/stellar-sdk');

const NETWORK_PASSPHRASE = Networks.TESTNET;
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function mockedStellarService() {
  return proxyquire('./stellarService', {
    '../config/stellar': {
      server: {
        loadAccount: async (key) => ({
          accountId: () => key,
          sequenceNumber: () => '100',
          incrementSequenceNumber: () => {},
          balances: [],
          thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 2 },
          signers: [{ key, weight: 1 }],
        }),
        submitTransaction: async () => ({ hash: 'hash' }),
      },
      networkPassphrase: NETWORK_PASSPHRASE,
      USDC: new Asset('USDC', USDC_ISSUER),
      isTestnet: true,
      configuredAssets: { USDC: { issuer: USDC_ISSUER } },
    },
    '../config/database': { query: async () => ({ rows: [] }) },
  });
}

test('contribution payment carries the referral code in the Stellar memo', async () => {
  const { buildUnsignedContributionPayment } = mockedStellarService();

  const xdr = await buildUnsignedContributionPayment({
    senderPublicKey: Keypair.random().publicKey(),
    destinationPublicKey: Keypair.random().publicKey(),
    asset: 'XLM',
    amount: '100',
    memo: 'ref:a1b2c3d4',
  });

  const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
  assert.equal(tx.memo.type, 'text');
  assert.equal(tx.memo.value.toString('utf8'), 'ref:a1b2c3d4');
});

test('contribution path payment carries the referral code in the Stellar memo', async () => {
  const { buildUnsignedContributionPathPayment } = mockedStellarService();

  const xdr = await buildUnsignedContributionPathPayment({
    senderPublicKey: Keypair.random().publicKey(),
    destinationPublicKey: Keypair.random().publicKey(),
    sendAsset: 'XLM',
    sendMax: '120',
    destAmount: '100',
    destAssetCode: 'USDC',
    memo: 'ref:a1b2c3d4',
  });

  const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
  assert.equal(tx.memo.value.toString('utf8'), 'ref:a1b2c3d4');
});

test('withdrawal transaction has one Payment per referrer plus one for the creator', async () => {
  const { buildWithdrawalTransaction } = mockedStellarService();

  const creator = Keypair.random().publicKey();
  const referrers = [
    { destinationPublicKey: Keypair.random().publicKey(), amount: '60.0000000' },
    { destinationPublicKey: Keypair.random().publicKey(), amount: '30.0000000' },
    { destinationPublicKey: Keypair.random().publicKey(), amount: '10.0000000' },
  ];

  const xdr = await buildWithdrawalTransaction({
    campaignWalletPublicKey: Keypair.random().publicKey(),
    destinationPublicKey: creator,
    amount: '900.0000000',
    asset: 'XLM',
    commissions: referrers,
  });

  const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
  assert.equal(tx.operations.length, 4);
  assert.equal(tx.operations[0].destination, creator);
  assert.equal(tx.operations[0].amount, '900.0000000');
  referrers.forEach((referrer, index) => {
    assert.equal(tx.operations[index + 1].type, 'payment');
    assert.equal(tx.operations[index + 1].destination, referrer.destinationPublicKey);
    assert.equal(tx.operations[index + 1].amount, referrer.amount);
  });
});

test('withdrawal transaction never includes a zero-amount commission payment', async () => {
  const { buildWithdrawalTransaction } = mockedStellarService();

  const paidReferrer = Keypair.random().publicKey();
  const xdr = await buildWithdrawalTransaction({
    campaignWalletPublicKey: Keypair.random().publicKey(),
    destinationPublicKey: Keypair.random().publicKey(),
    amount: '950.0000000',
    asset: 'XLM',
    commissions: [
      { destinationPublicKey: paidReferrer, amount: '50.0000000' },
      { destinationPublicKey: Keypair.random().publicKey(), amount: '0.0000000' },
      { destinationPublicKey: null, amount: '25.0000000' },
    ],
  });

  const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
  assert.equal(tx.operations.length, 2);
  assert.equal(tx.operations[1].destination, paidReferrer);
});

test('withdrawal transaction with no referrals stays a single creator payment', async () => {
  const { buildWithdrawalTransaction } = mockedStellarService();

  const xdr = await buildWithdrawalTransaction({
    campaignWalletPublicKey: Keypair.random().publicKey(),
    destinationPublicKey: Keypair.random().publicKey(),
    amount: '1000.0000000',
    asset: 'XLM',
  });

  const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
  assert.equal(tx.operations.length, 1);
});

test('withdrawal transaction includes creator revenue share payment to creator public key when collected fees > 0', async () => {
  const { buildWithdrawalTransaction, getPlatformPublicKey } = mockedStellarService();

  const creatorWithdrawalDest = Keypair.random().publicKey();
  const creatorPublicKey = Keypair.random().publicKey();
  const platformPublicKey = getPlatformPublicKey();

  const xdr = await buildWithdrawalTransaction({
    campaignWalletPublicKey: Keypair.random().publicKey(),
    destinationPublicKey: creatorWithdrawalDest,
    amount: '1000.0000000',
    asset: 'XLM',
    collectedFees: 100, // 5% default creator share = 5.0000000
    creatorPublicKey,
  });

  const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
  assert.equal(tx.operations.length, 2);
  // Main withdrawal
  assert.equal(tx.operations[0].destination, creatorWithdrawalDest);
  assert.equal(tx.operations[0].amount, '1000.0000000');
  // Creator revenue share goes to creatorPublicKey, NOT platformPublicKey
  assert.equal(tx.operations[1].destination, creatorPublicKey);
  assert.notEqual(tx.operations[1].destination, platformPublicKey);
  assert.equal(parseFloat(tx.operations[1].amount), 5);
});

