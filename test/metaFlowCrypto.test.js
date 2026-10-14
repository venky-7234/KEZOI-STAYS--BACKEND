const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  decryptFlowRequest,
  encryptFlowResponse,
  getMetaFlowConfiguration,
  verifyMetaSignature
} = require('../src/services/metaFlowCrypto.service');
const { handleFlowAction } = require('../src/services/metaFlowBooking.service');

const flowProperty = { id: 1, property_code: 'TG-0001', property_name: 'Kezoi Villa', bedrooms: 3,
  bathrooms: 3, max_guests: 8, base_price: 10000, included_guests: 4, extra_guest_price: 1000,
  currency: 'INR', gst_enabled: true, gst_rate: 18, price_includes_gst: false,
  public_description: 'Private villa', public_location: 'Hyderabad', public_amenities: ['Wi-Fi'] };

const encryptedJourneyDb = () => {
  let enquiry;
  return { query: async (sql, params = []) => {
    if (/FROM properties p/.test(sql)) return { rows: Number(params[2]) > flowProperty.max_guests ? [] : [{ ...flowProperty }] };
    if (/FROM properties WHERE id=/.test(sql)) return { rows: [{ ...flowProperty }] };
    if (/FROM property_marketing_photos WHERE/.test(sql)) return { rows: [{ id: 1, alt_text: 'Villa', meta_image_base64: 'iVBORw0KGgo=', display_order: 0, is_cover: true }] };
    if (/SELECT start_date, end_date FROM/.test(sql)) return { rows: [] };
    if (/integration_idempotency_key=/.test(sql)) return { rows: enquiry && enquiry.integration_idempotency_key === params[0] ? [enquiry] : [] };
    if (/SELECT \* FROM guests/.test(sql)) return { rows: [{ id: 7 }] };
    if (/INSERT INTO enquiries/.test(sql)) { enquiry = { id: 42, guest_id: 7, status: 'NEW', integration_idempotency_key: params[19], integration_request_hash: params[20] }; return { rows: [enquiry] }; }
    return { rows: [] };
  } };
};

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

test('round-trips real backend responses for every premium Flow screen through Meta encryption', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.META_FLOW_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
  process.env.JWT_SECRET = 'encrypted-journey-test-secret';
  process.env.WEBSITE_APPLICATION_URL = 'https://guest.kezoistays.test/identity-upload';
  const db = encryptedJourneyDb();
  const screens = ['BOOKING_DETAILS', 'PROPERTY_SELECTION', 'PROPERTY_DETAILS', 'CALENDAR', 'GUEST_SELECTION', 'LIVE_QUOTE', 'GUEST_DETAILS', 'BOOKING_REVIEW'];
  const journeyData = { property_id: '1', check_in: '2026-11-01', check_out: '2026-11-03', adults: 2,
    children: 0, infants: 0, pets: 0, guest_name: 'Test Guest', guest_email: 'test@example.com',
    whatsapp_number: '+919876543210', country_code: 'IN' };
  for (const screen of screens) {
    const aesKey = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
    const request = { action: 'data_exchange', screen, flow_token: 'test-flow-token', data: journeyData };
    const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(request)), cipher.final(), cipher.getAuthTag()]);
    const envelope = { encrypted_aes_key: crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aesKey).toString('base64'), encrypted_flow_data: encrypted.toString('base64'), initial_vector: iv.toString('base64') };
    const decrypted = decryptFlowRequest(envelope); assert.deepEqual(decrypted.data, request);
    const response = await handleFlowAction(db, decrypted.data);
    const ciphertext = Buffer.from(encryptFlowResponse(response, decrypted.aesKey, decrypted.iv), 'base64');
    const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, Buffer.from(iv.map(byte => ~byte & 0xff)));
    decipher.setAuthTag(ciphertext.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
    const roundTripped = JSON.parse(plaintext.toString());
    assert.deepEqual(roundTripped, response);
    assert.equal(Boolean(roundTripped.data?.error_message), false, `${screen} returned an error`);
  }
  delete process.env.JWT_SECRET;
  delete process.env.WEBSITE_APPLICATION_URL;
  delete process.env.META_FLOW_PRIVATE_KEY;
});
