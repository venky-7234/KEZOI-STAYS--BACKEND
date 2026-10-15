const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { handleFlowAction, enquiryKey } = require('../src/services/metaFlowBooking.service');
const flowDraft = require('../imports/kezoi-premium-booking-flow-draft.json');
const declaredFields = screen => new Set(Object.keys(flowDraft.screens.find(item => item.id === screen)?.data || {}));
const assertResponseMatchesDraft = response => {
  const allowed = declaredFields(response.screen);
  for (const key of Object.keys(response.data || {})) assert.ok(allowed.has(key), `${response.screen} returned undeclared data field ${key}`);
};

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
  process.env.WEBSITE_APPLICATION_URL = 'https://guest.kezoistays.test/identity-upload';
  const db = fakeDb();
  let response = await handleFlowAction(db, { action: 'data_exchange', screen: 'BOOKING_DETAILS', data: base });
  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'PROPERTY_SELECTION'); assert.equal(response.data.properties[0].id, '1');
  response = await handleFlowAction(db, { action: 'data_exchange', screen: 'PROPERTY_SELECTION', data: base });
  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'PROPERTY_DETAILS'); assert.deepEqual(response.data.gallery, [{ src: 'iVBORw0KGgo=', 'alt-text': 'Living room' }]);
  response = await handleFlowAction(db, { action: 'data_exchange', screen: 'PROPERTY_DETAILS', data: base });
  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'CALENDAR'); assert.deepEqual(response.data.unavailable_dates, ['2026-11-10', '2026-11-11']);
  response = await handleFlowAction(db, { action: 'data_exchange', screen: 'CALENDAR', data: base }); assert.equal(response.screen, 'GUEST_SELECTION');
  response = await handleFlowAction(db, { action: 'data_exchange', screen: 'GUEST_SELECTION', data: base });
  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'LIVE_QUOTE'); assert.equal(response.data.base_amount, 20000); assert.equal(response.data.gst_amount, 3600); assert.equal(response.data.total_amount, 23600);
  response = await handleFlowAction(db, { action: 'data_exchange', screen: 'LIVE_QUOTE', data: base }); assert.equal(response.screen, 'GUEST_DETAILS');
  const guest = { ...base, guest_name: 'Test Guest', guest_email: 'test@example.com', whatsapp_number: '+919876543210', country_code: 'IN' };
  response = await handleFlowAction(db, { action: 'data_exchange', screen: 'GUEST_DETAILS', data: guest }); assert.equal(response.screen, 'BOOKING_REVIEW');
  assertResponseMatchesDraft(response);
  response = await handleFlowAction(db, { action: 'data_exchange', screen: 'BOOKING_REVIEW', flow_token: guest.flow_token, data: guest });
  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'ENQUIRY_CREATED'); assert.equal(response.data.enquiry_status, 'NEW'); assert.equal(response.data.payment_status, 'NOT_STARTED'); assert.match(response.data.continuation_url, /^https:\/\/guest\.kezoistays\.test\/identity-upload\?/);
  const continuationUrl = new URL(response.data.continuation_url);
  const uploadClaims = jwt.verify(continuationUrl.searchParams.get('upload_token'), process.env.JWT_SECRET);
  assert.equal(continuationUrl.searchParams.get('enquiry'), '42');
  assert.equal(uploadClaims.purpose, 'IDENTITY_DOCUMENT_UPLOAD');
  assert.equal(uploadClaims.enquiry_id, 42);
  assert.equal(uploadClaims.guest_id, 7);
  assert.equal(uploadClaims.exp - uploadClaims.iat, 86400);
  delete process.env.JWT_SECRET;
  delete process.env.WEBSITE_APPLICATION_URL;
});

test('opens View Stay at dynamic property details and Reserve at the live calendar', async () => {
  const db = fakeDb();
  let response = await handleFlowAction(db, { action: 'data_exchange', screen: 'VIEW_STAY_ENTRY', data: { property_id: '1', entry_intent: 'view_stay' } });
  assert.equal(response.screen, 'PROPERTY_DETAILS');
  assert.equal(response.data.property_id, '1');
  assert.equal(response.data.property_description, property.public_description);
  assert.deepEqual(response.data.amenities, property.public_amenities);
  assert.equal(response.data.gallery.length, 1);

  response = await handleFlowAction(db, { action: 'data_exchange', screen: 'RESERVE_ENTRY', data: { property_id: '1', entry_intent: 'reserve' } });
  assert.equal(response.screen, 'CALENDAR');
  assert.equal(response.data.property_id, '1');
  assert.deepEqual(response.data.unavailable_dates, ['2026-11-10', '2026-11-11']);
});

test('routes Meta data_exchange entry request without a screen using view_stay intent', async () => {
  const response = await handleFlowAction(fakeDb(), {
    action: 'data_exchange',
    data: { property_id: '1', property_code: 'TG-0001', entry_intent: 'view_stay' },
    flow_token: 'flows-builder-00116197',
    version: '3.0'
  });

  assert.equal(response.screen, 'PROPERTY_DETAILS');
  assert.equal(response.data.property_id, '1');
  assert.equal(response.data.property_name, property.property_name);
  assert.equal(Object.hasOwn(response.data, 'property_code'), false);
  assert.equal(Object.hasOwn(response.data, 'flow_token'), false);
  assert.equal(Object.hasOwn(response.data, 'entry_intent'), false);
  assert.equal(response.data.property_description, property.public_description);
  assert.equal(response.data.gallery.length, 1);
  assert.equal(Object.hasOwn(response.data, 'error_message'), false);
  assertResponseMatchesDraft(response);
});

test('routes Meta data_exchange entry request without a screen using reserve intent', async () => {
  const response = await handleFlowAction(fakeDb(), {
    action: 'data_exchange',
    data: { property_id: '1', property_code: 'TG-0001', entry_intent: 'reserve' },
    flow_token: 'flows-builder-reserve-test',
    version: '3.0'
  });

  assert.equal(response.screen, 'CALENDAR');
  assert.equal(response.data.property_id, '1');
  assert.deepEqual(response.data.unavailable_dates, ['2026-11-10', '2026-11-11']);
  assert.equal(Object.hasOwn(response.data, 'error_message'), false);
  assertResponseMatchesDraft(response);
});

test('rejects a property code that does not match the selected active property ID', async () => {
  const response = await handleFlowAction(fakeDb(), {
    action: 'data_exchange',
    data: { property_id: '1', property_code: 'TG-0002', entry_intent: 'view_stay' }
  });
  assert.equal(response.screen, 'VIEW_STAY_ENTRY');
  assert.match(response.data.error_message, /not found or inactive/);
});

test('supports Meta INIT when selected-property entry data is supplied', async () => {
  const response = await handleFlowAction(fakeDb(), { action: 'INIT', flow_token: 'entry-token', data: { property_id: '1', entry_intent: 'view_stay' } });
  assert.equal(response.screen, 'PROPERTY_DETAILS');
  assert.equal(Object.hasOwn(response.data, 'flow_token'), false);
  assertResponseMatchesDraft(response);
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
  assert.equal(enquiryKey({ guest_email: 'guest@example.com' }), null);
});

test('does not create an enquiry when secure continuation is not configured', async () => {
  delete process.env.JWT_SECRET;
  delete process.env.WEBSITE_APPLICATION_URL;
  const response = await handleFlowAction(fakeDb(), {
    action: 'data_exchange',
    screen: 'BOOKING_REVIEW',
    flow_token: 'flow-token-123',
    data: { ...base, guest_name: 'Test Guest', guest_email: 'test@example.com', whatsapp_number: '+919876543210' }
  });
  assert.equal(response.screen, 'BOOKING_REVIEW');
  assert.match(response.data.error_message, /continuation is not configured/);
});

test('requires an explicit HTTPS identity-upload page', async () => {
  process.env.JWT_SECRET = 'test-secret-at-least-for-signing';
  delete process.env.WEBSITE_APPLICATION_URL;
  let response = await handleFlowAction(fakeDb(), {
    action: 'data_exchange', screen: 'BOOKING_REVIEW', flow_token: 'flow-token-123',
    data: { ...base, guest_name: 'Test Guest', guest_email: 'test@example.com', whatsapp_number: '+919876543210' }
  });
  assert.match(response.data.error_message, /identity-upload page is not configured/);
  process.env.WEBSITE_APPLICATION_URL = 'http://guest.kezoistays.test/identity-upload';
  response = await handleFlowAction(fakeDb(), {
    action: 'data_exchange', screen: 'BOOKING_REVIEW', flow_token: 'flow-token-123',
    data: { ...base, guest_name: 'Test Guest', guest_email: 'test@example.com', whatsapp_number: '+919876543210' }
  });
  assert.match(response.data.error_message, /must use HTTPS/);
  delete process.env.JWT_SECRET;
  delete process.env.WEBSITE_APPLICATION_URL;
});

test('requires the guest name before booking review', async () => {
  const response = await handleFlowAction(fakeDb(), {
    action: 'data_exchange',
    screen: 'GUEST_DETAILS',
    data: { ...base, guest_email: 'test@example.com', whatsapp_number: '+919876543210' }
  });
  assert.equal(response.screen, 'GUEST_DETAILS');
  assert.match(response.data.error_message, /Guest name is required/);
});
