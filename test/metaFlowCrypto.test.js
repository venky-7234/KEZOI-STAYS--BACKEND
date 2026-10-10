const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { decryptFlowRequest, encryptFlowResponse } = require('../src/services/metaFlowCrypto.service');

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
  assert.match(encryptFlowResponse({ data: { status: 'active' } }, decrypted.aesKey, decrypted.iv), /^[A-Za-z0-9+/=]+$/);
  delete process.env.META_FLOW_PRIVATE_KEY;
});
