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

test('handles CalendarPicker stay_dates object payload and numeric guest counts for LIVE_QUOTE', async () => {
  const db = fakeDb();
  // 1. BOOKING_DETAILS with stay_dates object (from form.stay_dates) and numeric guests
  const bookingDetailsPayload = {
    stay_dates: { 'start-date': '2026-11-01', 'end-date': '2026-11-03' },
    guests: 3,
    children: 1,
    infants: 0,
    pets: 0,
    location: 'Manikonda'
  };
  let response = await handleFlowAction(db, {
    action: 'data_exchange',
    screen: 'BOOKING_DETAILS',
    data: bookingDetailsPayload
  });
  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'PROPERTY_SELECTION');
  assert.equal(response.data.check_in, '2026-11-01');
  assert.equal(response.data.check_out, '2026-11-03');
  assert.equal(response.data.adults, 3);

  // 2. CALENDAR with stay_dates object
  response = await handleFlowAction(db, {
    action: 'data_exchange',
    screen: 'CALENDAR',
    data: {
      property_id: '1',
      stay_dates: { 'start-date': '2026-11-04', 'end-date': '2026-11-07' },
      adults: 2,
      children: 0,
      infants: 0,
      pets: 0
    }
  });
  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'GUEST_SELECTION');
  assert.equal(response.data.check_in, '2026-11-04');
  assert.equal(response.data.check_out, '2026-11-07');

  // 3. GUEST_SELECTION proceeding to LIVE_QUOTE with dynamic fields
  response = await handleFlowAction(db, {
    action: 'data_exchange',
    screen: 'GUEST_SELECTION',
    data: {
      property_id: '1',
      check_in: '2026-11-04',
      check_out: '2026-11-07',
      adults: 3,
      children: 1,
      infants: 0,
      pets: 0
    }
  });
  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'LIVE_QUOTE');
  assert.equal(response.data.nights, 3);
  assert.equal(typeof response.data.nights, 'number');
  assert.equal(response.data.check_in, '2026-11-04');
  assert.equal(typeof response.data.check_in, 'string');
  assert.equal(response.data.check_out, '2026-11-07');
  assert.equal(typeof response.data.check_out, 'string');
});

test('rejects missing, malformed, or inverted date ranges and preserves screen context', async () => {
  const db = fakeDb();

  // 1. Missing dates on BOOKING_DETAILS
  let response = await handleFlowAction(db, {
    action: 'data_exchange',
    screen: 'BOOKING_DETAILS',
    data: { guests: 2 }
  });
  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'BOOKING_DETAILS');
  assert.match(response.data.error_message, /YYYY-MM-DD/);

  // 2. Malformed dates
  response = await handleFlowAction(db, {
    action: 'data_exchange',
    screen: 'BOOKING_DETAILS',
    data: { check_in: '01-11-2026', check_out: '05-11-2026', guests: 2 }
  });
  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'BOOKING_DETAILS');
  assert.match(response.data.error_message, /YYYY-MM-DD/);

  // 3. check_out equal to check_in
  response = await handleFlowAction(db, {
    action: 'data_exchange',
    screen: 'CALENDAR',
    data: { property_id: '1', check_in: '2026-11-05', check_out: '2026-11-05', adults: 2 }
  });
  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'CALENDAR');
  assert.match(response.data.error_message, /check_out must be after check_in/);
  assert.ok(Array.isArray(response.data.unavailable_dates), 'Unavailable dates must be preserved on CALENDAR error');

  // 4. check_out before check_in
  response = await handleFlowAction(db, {
    action: 'data_exchange',
    screen: 'CALENDAR',
    data: { property_id: '1', check_in: '2026-11-08', check_out: '2026-11-05', adults: 2 }
  });
  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'CALENDAR');
  assert.match(response.data.error_message, /check_out must be after check_in/);
});

test('validates numeric guest counts, non-negativity, whole numbers, and property capacity', async () => {
  const db = fakeDb();

  // 1. Adults = 0
  let response = await handleFlowAction(db, {
    action: 'data_exchange',
    screen: 'GUEST_SELECTION',
    data: { property_id: '1', check_in: '2026-11-01', check_out: '2026-11-03', adults: 0 }
  });
  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'GUEST_SELECTION');
  assert.match(response.data.error_message, /adults must be at least 1/);

  // 2. Negative children count
  response = await handleFlowAction(db, {
    action: 'data_exchange',
    screen: 'GUEST_SELECTION',
    data: { property_id: '1', check_in: '2026-11-01', check_out: '2026-11-03', adults: 2, children: -1 }
  });
  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'GUEST_SELECTION');
  assert.match(response.data.error_message, /non-negative whole numbers/);

  // 3. Fractional guest count
  response = await handleFlowAction(db, {
    action: 'data_exchange',
    screen: 'GUEST_SELECTION',
    data: { property_id: '1', check_in: '2026-11-01', check_out: '2026-11-03', adults: 2.5 }
  });
  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'GUEST_SELECTION');
  assert.match(response.data.error_message, /non-negative whole numbers/);

  // 4. Exceeds property capacity (max_guests = 8)
  response = await handleFlowAction(db, {
    action: 'data_exchange',
    screen: 'GUEST_SELECTION',
    data: { property_id: '1', check_in: '2026-11-01', check_out: '2026-11-03', adults: 7, children: 3 }
  });
  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'GUEST_SELECTION');
  assert.match(response.data.error_message, /cannot accommodate these guests/);
});

test('handles duplicate final submissions idempotently and detects tamper attempts', async () => {
  process.env.JWT_SECRET = 'test-secret-at-least-for-signing';
  process.env.WEBSITE_APPLICATION_URL = 'https://guest.kezoistays.test/identity-upload';
  const db = fakeDb();
  const guestPayload = {
    ...base,
    guest_name: 'Idempotency Test Guest',
    guest_email: 'idempotent@example.com',
    whatsapp_number: '+919876543210',
    country_code: 'IN',
    flow_token: 'token-idem-999'
  };

  // 1. Initial submission succeeds and creates enquiry
  let response = await handleFlowAction(db, {
    action: 'data_exchange',
    screen: 'BOOKING_REVIEW',
    flow_token: guestPayload.flow_token,
    data: guestPayload
  });
  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'ENQUIRY_CREATED');
  assert.equal(response.data.replayed, false);
  assert.equal(response.data.enquiry_reference, 'APP-42');

  // 2. Duplicate submission with the same flow token returns replayed enquiry
  response = await handleFlowAction(db, {
    action: 'data_exchange',
    screen: 'BOOKING_REVIEW',
    flow_token: guestPayload.flow_token,
    data: guestPayload
  });
  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'ENQUIRY_CREATED');
  assert.equal(response.data.replayed, true);
  assert.equal(response.data.enquiry_reference, 'APP-42');

  // 3. Re-submission with the same token but tampered guest name/details is rejected with conflict
  const tamperedPayload = { ...guestPayload, guest_name: 'Tampered Attacker' };
  response = await handleFlowAction(db, {
    action: 'data_exchange',
    screen: 'BOOKING_REVIEW',
    flow_token: guestPayload.flow_token,
    data: tamperedPayload
  });
  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'BOOKING_REVIEW');
  assert.match(response.data.error_message, /already used for different booking details/);

  delete process.env.JWT_SECRET;
  delete process.env.WEBSITE_APPLICATION_URL;
});

test('LIVE_QUOTE response provides all declared quote fields and formatted display strings without raw placeholders', async () => {
  const db = fakeDb();
  const response = await handleFlowAction(db, {
    action: 'data_exchange',
    screen: 'GUEST_SELECTION',
    data: base
  });

  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'LIVE_QUOTE');
  assert.equal(typeof response.data.property_name, 'string');
  assert.equal(typeof response.data.stay_dates_text, 'string');
  assert.equal(typeof response.data.price_breakdown_text, 'string');
  assert.equal(typeof response.data.total_amount_text, 'string');
  assert.equal(typeof response.data.quote_caption_text, 'string');

  // Verify none of the formatted display strings leak raw template interpolation placeholders
  for (const text of [
    response.data.stay_dates_text,
    response.data.price_breakdown_text,
    response.data.total_amount_text,
    response.data.quote_caption_text
  ]) {
    assert.ok(!text.includes('${'), `Formatted display string contains raw placeholder: ${text}`);
  }

  // Verify actual values are rendered
  assert.ok(response.data.stay_dates_text.includes('2026-11-01 to 2026-11-03 • 2 nights'));
  assert.ok(response.data.price_breakdown_text.includes('Stay (2 nights): INR 20000'));
  assert.ok(response.data.price_breakdown_text.includes('GST (18%): INR 3600'));
  assert.ok(response.data.total_amount_text.includes('Total: INR 23600'));
  assert.ok(response.data.quote_caption_text.includes('Live quote calculated on'));

  // Verify raw numbers remain intact for downstream calculation and payload forwarding
  assert.equal(response.data.nights, 2);
  assert.equal(response.data.currency, 'INR');
  assert.equal(response.data.base_amount, 20000);
  assert.equal(response.data.extra_guests, 0);
  assert.equal(response.data.extra_guest_amount, 0);
  assert.equal(response.data.taxable_amount, 20000);
  assert.equal(response.data.gst_rate, 18);
  assert.equal(response.data.gst_amount, 3600);
  assert.equal(response.data.total_amount, 23600);
});

test('PROPERTY_DETAILS formats real property specs, verified amenities, and max_guests_text without raw placeholders', async () => {
  const db = fakeDb();
  const response = await handleFlowAction(db, {
    action: 'data_exchange',
    screen: 'PROPERTY_SELECTION',
    data: base
  });

  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'PROPERTY_DETAILS');
  assert.equal(response.data.property_name, 'Kezoi Villa');
  assert.equal(response.data.property_specs_text, '3 Bedrooms • 3 Bathrooms • Villa');
  assert.equal(response.data.max_guests_text, 'Accommodates up to 8 guests');
  assert.ok(!response.data.max_guests_text.includes('${'), 'max_guests_text must not contain raw placeholder');
  assert.equal(response.data.amenities_text, 'Wi-Fi • Kitchen');
  assert.equal(response.data.has_gallery, true);
  assert.equal(response.data.gallery.length, 1);
});

test('PROPERTY_DETAILS handles properties without photos gracefully with has_gallery false', async () => {
  const dbWithoutPhotos = {
    query: async (sql, params = []) => {
      if (/FROM properties WHERE id=/.test(sql)) return { rows: [{ ...property, id: 2, property_name: 'Kezoi Penthouse' }] };
      if (/FROM property_marketing_photos WHERE/.test(sql)) return { rows: [] };
      return { rows: [] };
    }
  };

  const response = await handleFlowAction(dbWithoutPhotos, {
    action: 'data_exchange',
    screen: 'VIEW_STAY_ENTRY',
    data: { property_id: '2', entry_intent: 'view_stay' }
  });

  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'PROPERTY_DETAILS');
  assert.equal(response.data.property_name, 'Kezoi Penthouse');
  assert.equal(response.data.has_gallery, false);
  assert.deepEqual(response.data.gallery, []);
});

test('supports property lookup by property_code directly when property_id is not provided', async () => {
  const db = {
    query: async (sql, params = []) => {
      if (/FROM properties WHERE LOWER\(property_code\)=/.test(sql)) {
        return { rows: [{ ...property, id: 1, property_code: 'TG-0001' }] };
      }
      if (/FROM property_marketing_photos WHERE/.test(sql)) {
        return { rows: [{ id: 9, alt_text: 'Living room', caption: null, meta_image_base64: 'iVBORw0KGgo=', display_order: 0, is_cover: true }] };
      }
      return { rows: [] };
    }
  };

  const response = await handleFlowAction(db, {
    action: 'data_exchange',
    screen: 'VIEW_STAY_ENTRY',
    data: { property_code: 'TG-0001', entry_intent: 'view_stay' }
  });

  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'PROPERTY_DETAILS');
  assert.equal(response.data.property_id, '1');
  assert.equal(response.data.property_name, 'Kezoi Villa');
});

test('rejects special_requests exceeding 600 characters in GUEST_DETAILS and createPendingEnquiry', async () => {
  const db = fakeDb();
  const oversizedRequests = 'a'.repeat(601);

  // 1. GUEST_DETAILS check
  const guestDetailsResponse = await handleFlowAction(db, {
    action: 'data_exchange',
    screen: 'GUEST_DETAILS',
    data: {
      ...base,
      guest_name: 'Test Guest',
      guest_email: 'test@example.com',
      whatsapp_number: '+919876543210',
      special_requests: oversizedRequests
    }
  });

  assert.equal(guestDetailsResponse.screen, 'GUEST_DETAILS');
  assert.match(guestDetailsResponse.data.error_message, /Special requests cannot exceed 600 characters/);

  // 2. createPendingEnquiry check
  process.env.JWT_SECRET = 'test-secret';
  process.env.WEBSITE_APPLICATION_URL = 'https://guest.kezoistays.test/upload';
  const reviewResponse = await handleFlowAction(db, {
    action: 'data_exchange',
    screen: 'BOOKING_REVIEW',
    flow_token: 'token-600',
    data: {
      ...base,
      guest_name: 'Test Guest',
      guest_email: 'test@example.com',
      whatsapp_number: '+919876543210',
      special_requests: oversizedRequests
    }
  });

  assert.equal(reviewResponse.screen, 'BOOKING_REVIEW');
  assert.match(reviewResponse.data.error_message, /Special requests cannot exceed 600 characters/);
  delete process.env.JWT_SECRET;
  delete process.env.WEBSITE_APPLICATION_URL;
});

test('PROPERTY_SELECTION returns multiple active properties from database records', async () => {
  const prop1 = { ...property, id: 1, property_code: 'TG-0001', property_name: 'Kezoi Villa Manikonda', bedrooms: 3, bathrooms: 3, max_guests: 8, base_price: 10000 };
  const prop2 = { ...property, id: 2, property_code: 'TG-0002', property_name: 'Kezoi Penthouse Gachibowli', bedrooms: 4, bathrooms: 4, max_guests: 12, base_price: 16000 };

  const multiPropDb = {
    query: async (sql, params = []) => {
      if (/FROM properties p/.test(sql)) {
        return { rows: [prop1, prop2] };
      }
      return { rows: [] };
    }
  };

  const response = await handleFlowAction(multiPropDb, {
    action: 'data_exchange',
    screen: 'BOOKING_DETAILS',
    data: { check_in: '2026-11-01', check_out: '2026-11-03', adults: 4, children: 0, infants: 0, pets: 0 }
  });

  assertResponseMatchesDraft(response);
  assert.equal(response.screen, 'PROPERTY_SELECTION');
  assert.equal(response.data.properties.length, 2);
  assert.equal(response.data.properties[0].id, '1');
  assert.equal(response.data.properties[0].title, 'Kezoi Villa Manikonda');
  assert.equal(response.data.properties[1].id, '2');
  assert.equal(response.data.properties[1].title, 'Kezoi Penthouse Gachibowli');
  assert.equal(response.data.has_available_properties, true);
  assert.equal(response.data.no_properties_available, false);
});

test('EXACT DASHBOARD PRICING PARITY: standard stay matches getPropertyAndQuote identically', async () => {
  const { getPropertyAndQuote } = require('../src/controllers/application.controller');
  const { selectedQuote } = require('../src/services/metaFlowBooking.service');

  const testProp = {
    id: 1,
    property_code: 'TG-0001',
    property_name: 'Kezoi Villa',
    base_price: 12000,
    included_guests: 4,
    extra_guest_price: 1500,
    max_guests: 8,
    currency: 'INR',
    gst_enabled: true,
    gst_rate: 18,
    price_includes_gst: false,
    status: 'ACTIVE'
  };

  const parityDb = {
    query: async (sql, params = []) => {
      if (/FROM properties p/.test(sql)) return { rows: [{ ...testProp }] };
      if (/FROM properties WHERE id\s*=/.test(sql)) return { rows: [{ ...testProp }] };
      if (/FROM bookings/.test(sql) || /FROM property_blocks/.test(sql)) return { rows: [] };
      if (/FROM mobile_discount_offers/.test(sql)) return { rows: [] };
      return { rows: [] };
    }
  };

  const stayData = {
    property_id: '1',
    check_in: '2026-11-01',
    check_out: '2026-11-04',
    adults: 3,
    children: 1,
    infants: 0,
    pets: 0
  };

  // Dashboard API quote
  const dashboardResult = await getPropertyAndQuote(
    parityDb,
    1,
    {
      checkIn: stayData.check_in,
      checkOut: stayData.check_out,
      nights: 3,
      pricedGuests: 4,
      totalOccupants: 4
    },
    null
  );

  // WhatsApp Flow quote
  const flowResult = await selectedQuote(parityDb, stayData);

  assert.equal(dashboardResult.error, undefined);
  assert.equal(flowResult.error, undefined);

  const dashQ = dashboardResult.quote;
  const flowQ = flowResult.property.quote;

  assert.equal(flowQ.nights, dashQ.nights);
  assert.equal(flowQ.base_price_per_night, dashQ.base_price_per_night);
  assert.equal(flowQ.included_guests, dashQ.included_guests);
  assert.equal(flowQ.extra_guests, dashQ.extra_guests);
  assert.equal(flowQ.extra_guest_price_per_night, dashQ.extra_guest_price_per_night);
  assert.equal(flowQ.base_amount, dashQ.base_amount);
  assert.equal(flowQ.extra_guest_amount, dashQ.extra_guest_amount);
  assert.equal(flowQ.original_amount, dashQ.original_amount);
  assert.equal(flowQ.discount_percentage, dashQ.discount_percentage);
  assert.equal(flowQ.discount_amount, dashQ.discount_amount);
  assert.equal(flowQ.taxable_amount, dashQ.taxable_amount);
  assert.equal(flowQ.gst_rate, dashQ.gst_rate);
  assert.equal(flowQ.cgst_amount, dashQ.cgst_amount);
  assert.equal(flowQ.sgst_amount, dashQ.sgst_amount);
  assert.equal(flowQ.gst_amount, dashQ.gst_amount);
  assert.equal(flowQ.total_amount, dashQ.total_amount);
  assert.equal(flowQ.currency, dashQ.currency);
});

test('EXACT DASHBOARD PRICING PARITY: extra guests calculation matches identically', async () => {
  const { getPropertyAndQuote } = require('../src/controllers/application.controller');
  const { selectedQuote } = require('../src/services/metaFlowBooking.service');

  const testProp = {
    id: 1,
    property_code: 'TG-0001',
    property_name: 'Kezoi Villa',
    base_price: 10000,
    included_guests: 4,
    extra_guest_price: 1200,
    max_guests: 10,
    currency: 'INR',
    gst_enabled: true,
    gst_rate: 18,
    price_includes_gst: false,
    status: 'ACTIVE'
  };

  const parityDb = {
    query: async (sql, params = []) => {
      if (/FROM properties p/.test(sql)) return { rows: [{ ...testProp }] };
      if (/FROM properties WHERE id\s*=/.test(sql)) return { rows: [{ ...testProp }] };
      if (/FROM bookings/.test(sql) || /FROM property_blocks/.test(sql)) return { rows: [] };
      if (/FROM mobile_discount_offers/.test(sql)) return { rows: [] };
      return { rows: [] };
    }
  };

  // 4 nights, 6 adults + 2 children = 8 priced guests (4 extra guests)
  const stayData = {
    property_id: '1',
    check_in: '2026-11-05',
    check_out: '2026-11-09',
    adults: 6,
    children: 2,
    infants: 1, // infants do not count towards priced occupants
    pets: 1
  };

  const dashboardResult = await getPropertyAndQuote(
    parityDb,
    1,
    {
      checkIn: stayData.check_in,
      checkOut: stayData.check_out,
      nights: 4,
      pricedGuests: 8,
      totalOccupants: 9
    },
    null
  );

  const flowResult = await selectedQuote(parityDb, stayData);

  assert.equal(dashboardResult.error, undefined);
  assert.equal(flowResult.error, undefined);

  const dashQ = dashboardResult.quote;
  const flowQ = flowResult.property.quote;

  assert.equal(flowQ.nights, 4);
  assert.equal(flowQ.extra_guests, 4);
  assert.equal(flowQ.base_amount, 40000); // 10000 * 4
  assert.equal(flowQ.extra_guest_amount, 19200); // 4 extra * 1200 * 4 nights
  assert.equal(flowQ.original_amount, 59200);
  assert.equal(flowQ.taxable_amount, 59200);
  assert.equal(flowQ.gst_amount, 10656); // 18% of 59200
  assert.equal(flowQ.total_amount, 69856);

  // Exact parity match
  assert.deepEqual(flowQ, dashQ);
});

test('EXACT DASHBOARD PRICING PARITY: active mobile discount offer matches identically', async () => {
  const { getPropertyAndQuote } = require('../src/controllers/application.controller');
  const { selectedQuote } = require('../src/services/metaFlowBooking.service');

  const testProp = {
    id: 1,
    property_code: 'TG-0001',
    property_name: 'Kezoi Villa',
    base_price: 15000,
    included_guests: 6,
    extra_guest_price: 1500,
    max_guests: 10,
    currency: 'INR',
    gst_enabled: true,
    gst_rate: 18,
    price_includes_gst: false,
    status: 'ACTIVE'
  };

  const mobileOffer = {
    id: 99,
    mobile_number: '+919876543210',
    discount_percentage: 10.0,
    reason: 'VIP Returning Guest',
    status: 'ACTIVE',
    valid_until: '2026-12-31T23:59:59.000Z'
  };

  const parityDb = {
    query: async (sql, params = []) => {
      if (/FROM properties p/.test(sql)) return { rows: [{ ...testProp }] };
      if (/FROM properties WHERE id\s*=/.test(sql)) return { rows: [{ ...testProp }] };
      if (/FROM bookings/.test(sql) || /FROM property_blocks/.test(sql)) return { rows: [] };
      if (/FROM mobile_discount_offers/.test(sql)) {
        if (params[0] === '+919876543210') return { rows: [{ ...mobileOffer }] };
        return { rows: [] };
      }
      return { rows: [] };
    }
  };

  const stayData = {
    property_id: '1',
    check_in: '2026-11-10',
    check_out: '2026-11-12',
    adults: 4,
    children: 0,
    infants: 0,
    pets: 0,
    whatsapp_number: '+919876543210',
    country_code: 'IN'
  };

  const dashboardResult = await getPropertyAndQuote(
    parityDb,
    1,
    {
      checkIn: stayData.check_in,
      checkOut: stayData.check_out,
      nights: 2,
      pricedGuests: 4,
      totalOccupants: 4
    },
    '+919876543210'
  );

  const flowResult = await selectedQuote(parityDb, stayData);

  assert.equal(dashboardResult.error, undefined);
  assert.equal(flowResult.error, undefined);

  const dashQ = dashboardResult.quote;
  const flowQ = flowResult.property.quote;

  assert.equal(flowQ.base_amount, 30000); // 15000 * 2
  assert.equal(flowQ.original_amount, 30000);
  assert.equal(flowQ.discount_percentage, 10);
  assert.equal(flowQ.discount_amount, 3000); // 10% of 30000
  assert.equal(flowQ.taxable_amount, 27000); // 30000 - 3000
  assert.equal(flowQ.gst_amount, 4860); // 18% of 27000
  assert.equal(flowQ.cgst_amount, 2430);
  assert.equal(flowQ.sgst_amount, 2430);
  assert.equal(flowQ.total_amount, 31860);
  assert.equal(flowQ.mobile_discount_applied, true);
  assert.equal(flowQ.mobile_discount_offer_id, 99);

  // Exact parity match
  assert.deepEqual(flowQ, dashQ);
});

test('EXACT DASHBOARD PRICING PARITY: GST-inclusive configuration is rejected by both systems', async () => {
  const { getPropertyAndQuote } = require('../src/controllers/application.controller');
  const { selectedQuote } = require('../src/services/metaFlowBooking.service');

  const testProp = {
    id: 1,
    property_code: 'TG-0001',
    property_name: 'Kezoi Inclusive',
    base_price: 10000,
    included_guests: 4,
    extra_guest_price: 1000,
    max_guests: 8,
    currency: 'INR',
    gst_enabled: true,
    gst_rate: 18,
    price_includes_gst: true, // Unsupported configuration
    status: 'ACTIVE'
  };

  const parityDb = {
    query: async (sql, params = []) => {
      // In availability.service.js, SQL filters out properties where price_includes_gst IS TRUE
      if (/FROM properties p/.test(sql)) return { rows: [] };
      if (/FROM properties WHERE id\s*=/.test(sql)) return { rows: [{ ...testProp }] };
      return { rows: [] };
    }
  };

  const stayData = {
    property_id: '1',
    check_in: '2026-11-01',
    check_out: '2026-11-03',
    adults: 2,
    children: 0,
    infants: 0,
    pets: 0
  };

  const dashboardResult = await getPropertyAndQuote(
    parityDb,
    1,
    {
      checkIn: stayData.check_in,
      checkOut: stayData.check_out,
      nights: 2,
      pricedGuests: 2,
      totalOccupants: 2
    },
    null
  );

  const flowResult = await selectedQuote(parityDb, stayData);

  assert.equal(dashboardResult.status, 500);
  assert.match(dashboardResult.error, /GST-inclusive property pricing is not supported/);
  assert.equal(flowResult.status, 409);
  assert.match(flowResult.error, /Property is unavailable/);
});

test('EXACT DASHBOARD PRICING PARITY: createPendingEnquiry persists exact discount and quote fields', async () => {
  const { createPendingEnquiry, enquiryKey } = require('../src/services/metaFlowBooking.service');
  process.env.JWT_SECRET = 'test-secret';
  process.env.WEBSITE_APPLICATION_URL = 'https://guest.kezoistays.test/upload';

  let capturedEnquiryParams = null;
  const parityDb = {
    query: async (sql, params = []) => {
      if (/FROM properties p/.test(sql)) return { rows: [{ ...property, base_price: 20000 }] };
      if (/FROM properties WHERE id\s*=/.test(sql)) return { rows: [{ ...property, base_price: 20000 }] };
      if (/FROM mobile_discount_offers/.test(sql)) {
        return {
          rows: [{
            id: 88,
            mobile_number: '+919876543210',
            discount_percentage: 20,
            status: 'ACTIVE'
          }]
        };
      }
      if (/SELECT \* FROM guests/.test(sql)) return { rows: [{ id: 7 }] };
      if (/INSERT INTO enquiries/.test(sql)) {
        capturedEnquiryParams = params;
        return {
          rows: [{
            id: 101,
            guest_id: 7,
            status: 'NEW',
            quoted_total_amount: params[9],
            discount_percentage: params[21],
            discount_amount: params[22],
            mobile_discount_offer_id: params[23],
            integration_idempotency_key: params[19],
            integration_request_hash: params[20]
          }]
        };
      }
      return { rows: [] };
    }
  };

  const submission = {
    property_id: '1',
    check_in: '2026-11-01',
    check_out: '2026-11-03', // 2 nights
    adults: 2,
    children: 0,
    infants: 0,
    pets: 0,
    guest_name: 'Parity Guest',
    guest_email: 'guest@example.com',
    whatsapp_number: '+919876543210',
    country_code: 'IN',
    flow_token: 'parity-token-123'
  };

  const result = await createPendingEnquiry(parityDb, submission);
  assert.equal(result.replayed, false);
  assert.ok(capturedEnquiryParams);

  // Gross = 20000 * 2 = 40000
  // Discount = 20% of 40000 = 8000
  // Taxable = 32000
  // GST 18% = 5760
  // Total = 37760
  assert.equal(capturedEnquiryParams[9], 37760); // total_amount
  assert.equal(capturedEnquiryParams[10], 40000); // base_amount
  assert.equal(capturedEnquiryParams[12], 40000); // original_amount
  assert.equal(capturedEnquiryParams[13], 32000); // taxable_amount
  assert.equal(capturedEnquiryParams[14], 18); // gst_rate
  assert.equal(capturedEnquiryParams[17], 5760); // gst_amount
  assert.equal(capturedEnquiryParams[19], enquiryKey(submission)); // key at idx 19
  assert.equal(capturedEnquiryParams[21], 20); // discount_percentage
  assert.equal(capturedEnquiryParams[22], 8000); // discount_amount
  assert.equal(capturedEnquiryParams[23], 88); // mobile_discount_offer_id

  delete process.env.JWT_SECRET;
  delete process.env.WEBSITE_APPLICATION_URL;
});



