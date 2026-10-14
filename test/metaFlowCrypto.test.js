const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  decryptFlowRequest,
  encryptFlowResponse,
  getMetaFlowConfiguration,
  verifyMetaSignature
} = require('../src/services/metaFlowCrypto.service');

test('validates the Meta signature against the original raw request bytes', () => {
  process.env.META_APP_SECRET = 'test-only-app-secret';
  const rawBody = Buffer.from('{ "value": "preserve value" }');
  const signature = `sha256=${crypto.createHmac('sha256', process.env.META_APP_SECRET).update(rawBody).digest('hex')}`;

  assert.equal(verifyMetaSignature(rawBody, signature), true);
  assert.equal(verifyMetaSignature(Buffer.from(JSON.stringify(JSON.parse(rawBody))), signature), false);
  assert.equal(verifyMetaSignature(rawBody, signature.replace('sha256=', 'sha1=')), false);
  assert.equal(verifyMetaSignature(Buffer.concat([rawBody, Buffer.from(' ')]), signature), false);
  delete process.env.META_APP_SECRET;
});

test('decrypts a Meta-style request and encrypts a flipped-IV response', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.META_FLOW_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const aesKey = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const request = { action: 'ping' };
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(request)), cipher.final(), cipher.getAuthTag()]);
  const envelope = {
    encrypted_aes_key: crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aesKey).toString('base64'),
    encrypted_flow_data: ciphertext.toString('base64'),
    initial_vector: iv.toString('base64')
  };
  const decrypted = decryptFlowRequest(envelope);
  assert.deepEqual(decrypted.data, request);
  const encryptedResponse = Buffer.from(
    encryptFlowResponse({ data: { status: 'active' } }, decrypted.aesKey, decrypted.iv),
    'base64'
  );
  const flippedIv = Buffer.from(iv.map(byte => ~byte & 0xff));
  const responseDecipher = crypto.createDecipheriv('aes-128-gcm', aesKey, flippedIv);
  responseDecipher.setAuthTag(encryptedResponse.subarray(-16));
  const responsePlaintext = Buffer.concat([
    responseDecipher.update(encryptedResponse.subarray(0, -16)),
    responseDecipher.final()
  ]);

  assert.deepEqual(JSON.parse(responsePlaintext.toString('utf8')), { data: { status: 'active' } });
  const configuration = getMetaFlowConfiguration();
  assert.equal(configuration.privateKeyValid, true);
  assert.match(configuration.publicKeyFingerprint, /^[a-f0-9]{64}$/);
  delete process.env.META_FLOW_PRIVATE_KEY;
});

test('round-trips encrypted request and response envelopes for every premium Flow screen', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.META_FLOW_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const screens = ['BOOKING_DETAILS', 'PROPERTY_SELECTION', 'PROPERTY_DETAILS', 'CALENDAR', 'GUEST_SELECTION', 'LIVE_QUOTE', 'GUEST_DETAILS', 'BOOKING_REVIEW'];
  for (const screen of screens) {
    const aesKey = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
    const request = { action: 'data_exchange', screen, flow_token: 'test-flow-token', data: { property_id: '1' } };
    const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(request)), cipher.final(), cipher.getAuthTag()]);
    const envelope = { encrypted_aes_key: crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aesKey).toString('base64'), encrypted_flow_data: encrypted.toString('base64'), initial_vector: iv.toString('base64') };
    const decrypted = decryptFlowRequest(envelope); assert.deepEqual(decrypted.data, request);
    const response = { screen, data: { verified_screen: screen } };
    const ciphertext = Buffer.from(encryptFlowResponse(response, decrypted.aesKey, decrypted.iv), 'base64');
    const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, Buffer.from(iv.map(byte => ~byte & 0xff)));
    decipher.setAuthTag(ciphertext.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
    assert.deepEqual(JSON.parse(plaintext.toString()), response);
  }
  delete process.env.META_FLOW_PRIVATE_KEY;
});
