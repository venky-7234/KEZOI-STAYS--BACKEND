const crypto = require('crypto');
require('dotenv').config({ path: process.env.ENV_FILE || '.env' });

const endpoint = process.env.META_FLOW_SMOKE_URL || 'https://api.kezoistays.com/api/meta/flows/booking';
const healthEndpoint = new URL('/api/meta/flows/health', endpoint).toString();
const privateKeyPem = String(process.env.META_FLOW_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const appSecret = process.env.META_APP_SECRET;

if (!privateKeyPem || !appSecret) throw new Error('META_FLOW_PRIVATE_KEY and META_APP_SECRET are required');

const privateKey = crypto.createPrivateKey({ key: privateKeyPem, passphrase: process.env.META_FLOW_PRIVATE_KEY_PASSPHRASE || undefined });
const publicKey = crypto.createPublicKey(privateKey);
const fingerprint = crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');

const exchange = async request => {
  const aesKey = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(request)), cipher.final(), cipher.getAuthTag()]);
  const envelope = {
    encrypted_aes_key: crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aesKey).toString('base64'),
    encrypted_flow_data: encrypted.toString('base64'),
    initial_vector: iv.toString('base64')
  };
  const rawBody = JSON.stringify(envelope);
  const signature = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body: rawBody });
  const body = await response.text();
  if (!response.ok) throw new Error(`${request.screen || request.action}: HTTP ${response.status} ${body.slice(0, 160)}`);
  const ciphertext = Buffer.from(body, 'base64');
  const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, Buffer.from(iv.map(byte => ~byte & 0xff)));
  decipher.setAuthTag(ciphertext.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString('utf8'));
};

const iso = date => date.toISOString().slice(0, 10);
const futureStay = async propertyId => {
  const unavailableUrl = new URL(`/api/applications/properties/${propertyId}/unavailable-dates`, endpoint);
  const response = await fetch(unavailableUrl);
  if (!response.ok) throw new Error(`Unavailable dates: HTTP ${response.status}`);
  const payload = await response.json();
  const blocked = new Set(payload.unavailable_dates || payload.dates || []);
  for (let offset = 30; offset < 365; offset += 1) {
    const start = new Date(); start.setUTCDate(start.getUTCDate() + offset);
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + 2);
    const secondNight = new Date(start); secondNight.setUTCDate(secondNight.getUTCDate() + 1);
    if (!blocked.has(iso(start)) && !blocked.has(iso(secondNight))) return { check_in: iso(start), check_out: iso(end) };
  }
  throw new Error('No safe two-night smoke-test window found');
};

(async () => {
  const healthResponse = await fetch(healthEndpoint);
  const health = await healthResponse.json();
  if (!healthResponse.ok || !health.configured) throw new Error('Production Flow health is not configured');
  if (health.publicKeyFingerprint !== fingerprint) throw new Error('Local private key does not match the production Flow public-key fingerprint');

  const ping = await exchange({ action: 'ping' });
  const stay = await futureStay('1');
  const flowToken = `read-only-smoke-${crypto.randomUUID()}`;
  let data = { ...stay, guests: '2', adults: '2', children: '0', infants: '0', pets: '0' };
  const results = [{ request: 'ping', response: ping.data?.status }];
  for (const screen of ['BOOKING_DETAILS', 'PROPERTY_SELECTION', 'PROPERTY_DETAILS', 'CALENDAR', 'GUEST_SELECTION', 'LIVE_QUOTE', 'GUEST_DETAILS']) {
    if (screen === 'PROPERTY_SELECTION') data.property_id = '1';
    if (screen === 'GUEST_DETAILS') Object.assign(data, { guest_name: 'Kezoi Production Smoke Test', guest_email: 'flow-smoke@example.com', whatsapp_number: '+919876543210', country_code: 'IN', special_requests: 'Read-only smoke test; do not create an enquiry' });
    const response = await exchange({ action: 'data_exchange', screen, flow_token: flowToken, data });
    if (response.data?.error_message) throw new Error(`${screen}: ${response.data.error_message}`);
    data = { ...data, ...response.data };
    results.push({ request: screen, response: response.screen, propertyDescriptionPresent: response.data?.property_description ? true : undefined, amenities: response.data?.amenities?.length, galleryItems: response.data?.gallery?.length, unavailableDates: response.data?.unavailable_dates?.length, total: response.data?.total_amount ?? response.data?.quote?.total_amount });
  }
  console.log(JSON.stringify({ endpoint, fingerprintMatched: true, stay, results, finalWriteSkipped: true }, null, 2));
})().catch(error => { console.error(`Meta Flow smoke failed: ${error.message}`); process.exitCode = 1; });
