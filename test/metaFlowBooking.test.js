const test = require('node:test');
const assert = require('node:assert/strict');
const { handleFlowAction, enquiryKey } = require('../src/services/metaFlowBooking.service');

const property = { id: 1, property_code: 'TG-0001', property_name: 'Kezoi Villa', property_type: 'VILLA', area: 'Manikonda', city: 'Hyderabad', bedrooms: 3, bathrooms: 3, max_guests: 8, base_price: 10000, included_guests: 4, extra_guest_price: 1000, currency: 'INR', gst_enabled: true, gst_rate: 18, price_includes_gst: false, public_description: 'Private city villa', public_location: 'Manikonda, Hyderabad', public_amenities: ['Wi-Fi', 'Kitchen'] };

const fakeDb = () => {
  let enquiry;
  return { query: async (sql, params = []) => {
    if (/FROM properties p/.test(sql)) return { rows: Number(params[2]) > property.max_guests ? [] : [{ ...property }] };
    if (/FROM properties WHERE id=/.test(sql)) return { rows: [{ ...property }] };
    if (/FROM property_marketing_photos WHERE/.test(sql)) return { rows: [{ id: 9, alt_text: 'Living room', caption: null, meta_image_base64: 'iVBORw0KGgo=', display_order: 0, is_cover: true }] };
    if (/SELECT start_date, end_date FROM/.test(sql)) return { rows: [{ start_date: '2026-11-10', end_date: '2026-11-12' }] };
    if (/integration_idempotency_key=/.test(sql)) return { rows: enquiry && enquiry.integration_idempotency_key === params[0] ? [enquiry] : [] };
    if (/SELECT \* FROM guests/.test(sql)) return { rows: [{ id: 7 }] };
    if (/INSERT INTO enquiries/.test(sql)) { enquiry = { id: 42, guest_id: 7, status: 'NEW', integration_idempotency_key: params[19], integration_request_hash: params[20] }; return { rows: [enquiry] }; }
    return { rows: [] };
  }};
};

const base = { property_id: '1', check_in: '2026-11-01', check_out: '2026-11-03', adults: 2, children: 1, infants: 0, pets: 0, flow_token: 'flow-token-123' };

test('serves every premium Flow screen from backend data and creates only a pending enquiry', async () => {
  process.env.JWT_SECRET = 'test-secret-at-least-for-signing';
  const db = fakeDb();
  let response = await handleFlowAction(db, { action: 'data_exchange', screen: 'BOOKING_DETAILS', data: base });
  assert.equal(response.screen, 'PROPERTY_SELECTION'); assert.equal(response.data.properties[0].id, '1');
  response = await handleFlowAction(db, { action: 'data_exchange', screen: 'PROPERTY_SELECTION', data: base });
  assert.equal(response.screen, 'PROPERTY_DETAILS'); assert.deepEqual(response.data.gallery, [{ src: 'iVBORw0KGgo=', 'alt-text': 'Living room' }]);
  response = await handleFlowAction(db, { action: 'data_exchange', screen: 'PROPERTY_DETAILS', data: base });
  assert.equal(response.screen, 'CALENDAR'); assert.deepEqual(response.data.unavailable_dates, ['2026-11-10', '2026-11-11']);
  response = await handleFlowAction(db, { action: 'data_exchange', screen: 'CALENDAR', data: base }); assert.equal(response.screen, 'GUEST_SELECTION');
  response = await handleFlowAction(db, { action: 'data_exchange', screen: 'GUEST_SELECTION', data: base });
  assert.equal(response.screen, 'LIVE_QUOTE'); assert.equal(response.data.base_amount, 20000); assert.equal(response.data.gst_amount, 3600); assert.equal(response.data.total_amount, 23600);
  response = await handleFlowAction(db, { action: 'data_exchange', screen: 'LIVE_QUOTE', data: base }); assert.equal(response.screen, 'GUEST_DETAILS');
  const guest = { ...base, guest_name: 'Test Guest', guest_email: 'test@example.com', whatsapp_number: '+919876543210', country_code: 'IN' };
  response = await handleFlowAction(db, { action: 'data_exchange', screen: 'GUEST_DETAILS', data: guest }); assert.equal(response.screen, 'BOOKING_REVIEW');
  response = await handleFlowAction(db, { action: 'data_exchange', screen: 'BOOKING_REVIEW', flow_token: guest.flow_token, data: guest });
  assert.equal(response.screen, 'ENQUIRY_CREATED'); assert.equal(response.data.enquiry_status, 'NEW'); assert.equal(response.data.payment_status, 'NOT_STARTED'); assert.match(response.data.continuation_url, /upload_token=/);
  delete process.env.JWT_SECRET;
});

test('rejects blocked dates and capacity changes on the live backend checks', async () => {
  const db = fakeDb();
  let response = await handleFlowAction(db, { action: 'data_exchange', screen: 'CALENDAR', data: { ...base, check_in: '2026-11-10', check_out: '2026-11-11' } });
  assert.match(response.data.error_message, /no longer available/);
  response = await handleFlowAction(db, { action: 'data_exchange', screen: 'GUEST_SELECTION', data: { ...base, adults: 9 } });
  assert.match(response.data.error_message, /unavailable|accommodate/);
});

test('derives a stable non-PII idempotency key from the Flow token', () => {
  assert.equal(enquiryKey({ flow_token: 'same-token' }), enquiryKey({ flow_token: 'same-token', guest_email: 'different@example.com' }));
  assert.match(enquiryKey({ flow_token: 'same-token' }), /^meta-flow:[a-f0-9]{64}$/);
});
