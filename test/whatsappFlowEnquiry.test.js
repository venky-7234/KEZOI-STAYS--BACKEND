const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  isFlowCompletionEvent,
  validateFlowPayload,
  convertFlowInboxEventToEnquiry
} = require('../src/services/whatsappFlowEnquiry.service');
const { enquiryKey } = require('../src/services/metaFlowBooking.service');
const { validateApproval } = require('../src/services/enquiryWorkflow.service');

// Configure test environment for secure continuation
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-chars-long';
process.env.WEBSITE_APPLICATION_URL = 'https://guest.kezoistays.test/identity-upload';

const defaultProperty = {
  id: 1,
  property_code: 'TG-0001',
  property_name: 'Kezoi Villa',
  property_type: 'VILLA',
  area: 'Manikonda',
  city: 'Hyderabad',
  bedrooms: 3,
  bathrooms: 3,
  max_guests: 8,
  base_price: 10000,
  included_guests: 4,
  extra_guest_price: 1000,
  currency: 'INR',
  gst_enabled: true,
  gst_rate: 18,
  price_includes_gst: false,
  public_description: 'Private luxury city villa',
  public_location: 'Manikonda, Hyderabad',
  public_amenities: ['Wi-Fi', 'Kitchen']
};

/**
 * Creates an isolated mock database pool for unit testing.
 * @param {object} [options]
 * @returns {object}
 */
const createMockDb = (options = {}) => {
  const executedQueries = [];
  let existingEnquiry = options.initialEnquiry || null;
  let clientReleased = false;

  const client = {
    queries: executedQueries,
    query: async (sql, params = []) => {
      executedQueries.push({ sql, params });

      // Simulated query error for rollback testing
      if (options.simulateErrorTarget && sql.includes(options.simulateErrorTarget)) {
        throw new Error(options.simulateErrorMessage || 'Simulated database transaction failure');
      }

      // Check existing enquiry by integration_idempotency_key
      if (sql.includes('integration_idempotency_key=$1')) {
        if (existingEnquiry && existingEnquiry.integration_idempotency_key === params[0]) {
          return { rows: [existingEnquiry], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // Advisory transaction lock
      if (sql.includes('pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 0 };
      }

      // Property availability search
      if (sql.includes('FROM properties p')) {
        if (options.propertyInactive) {
          return { rows: [], rowCount: 0 };
        }
        const occupantCount = Number(params[2]);
        if (occupantCount > defaultProperty.max_guests) {
          return { rows: [], rowCount: 0 };
        }
        if (options.datesBlocked) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ ...defaultProperty }], rowCount: 1 };
      }

      // Property details by ID
      if (sql.includes('FROM properties WHERE id=')) {
        if (options.propertyInactive) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ ...defaultProperty }], rowCount: 1 };
      }

      // Guest lookup
      if (sql.includes('SELECT * FROM guests')) {
        return { rows: [{ id: 7, full_name: 'Test Guest', email: 'test@example.com' }], rowCount: 1 };
      }

      // Guest insertion
      if (sql.includes('INSERT INTO guests')) {
        return { rows: [{ id: 7, full_name: params[0], email: params[1] }], rowCount: 1 };
      }

      // Enquiry insertion
      if (sql.includes('INSERT INTO enquiries')) {
        existingEnquiry = {
          id: 42,
          guest_id: 7,
          property_id: 1,
          source: 'WHATSAPP',
          check_in: params[2],
          check_out: params[3],
          adults: params[4],
          children: params[5],
          infants: params[6],
          pets: params[7],
          status: 'NEW',
          document_verification_status: 'PENDING',
          quoted_total_amount: params[9],
          integration_idempotency_key: params[19],
          integration_request_hash: params[20]
        };
        return { rows: [existingEnquiry], rowCount: 1 };
      }

      // whatsapp_inbound_events update (markEventProcessed / markEventFailed)
      if (sql.includes('UPDATE whatsapp_inbound_events')) {
        if (options.simulateOwnershipLost) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ id: params[0], status: 'UPDATED' }], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
    release: () => {
      clientReleased = true;
    }
  };

  return {
    connect: async () => client,
    query: client.query,
    get clientReleased() {
      return clientReleased;
    },
    get existingEnquiry() {
      return existingEnquiry;
    },
    executedQueries
  };
};

const createValidEvent = (overrides = {}) => ({
  id: '101',
  event_kind: 'message',
  meta_message_id: 'wamid.HBgLMTEwMQ==',
  event_type: 'interactive_nfm_reply',
  sender_phone_masked: '***3210',
  sender_phone_hash: 'a1b2c3d4e5f6',
  locked_by: 'worker-unit-01',
  processing_status: 'PROCESSING',
  payload: {
    flow_token: 'flow-token-test-123',
    flow_name: 'kezoi_stays_booking',
    property_id: '1',
    check_in: '2026-11-01',
    check_out: '2026-11-03',
    adults: 2,
    children: 1,
    infants: 0,
    pets: 0,
    guest_name: 'Jane Doe',
    guest_email: 'jane@example.com',
    whatsapp_number: '+919876543210',
    country_code: 'IN',
    special_requests: 'Quiet room please'
  },
  ...overrides
});

// ============================================================================
// TESTS
// ============================================================================

test('isFlowCompletionEvent identifies valid Flow completions and rejects non-Flow events', () => {
  assert.equal(isFlowCompletionEvent({ event_kind: 'message', event_type: 'interactive_nfm_reply' }), true);
  assert.equal(isFlowCompletionEvent({ event_kind: 'message', event_type: 'nfm_reply' }), true);

  // Non-flow events must be rejected
  assert.equal(isFlowCompletionEvent({ event_kind: 'message', event_type: 'text' }), false);
  assert.equal(isFlowCompletionEvent({ event_kind: 'message', event_type: 'button_reply' }), false);
  assert.equal(isFlowCompletionEvent({ event_kind: 'status', event_type: 'delivered' }), false);
  assert.equal(isFlowCompletionEvent(null), false);
  assert.equal(isFlowCompletionEvent({}), false);
});

test('validateFlowPayload validates required fields, types, and telephone numbers', () => {
  const valid = createValidEvent().payload;
  assert.deepEqual(validateFlowPayload(valid), { valid: true, error: null });

  // Missing required fields
  assert.match(validateFlowPayload({ ...valid, guest_name: '' }).error, /Missing required fields: guest_name/);
  assert.match(validateFlowPayload({ ...valid, whatsapp_number: '' }).error, /Missing required fields: whatsapp_number/);
  assert.match(validateFlowPayload({ ...valid, check_in: '' }).error, /Missing required fields: check_in/);

  // Invalid property ID
  assert.match(validateFlowPayload({ ...valid, property_id: 'villa-abc' }).error, /property_id must be a valid numeric ID/);

  // Invalid email format
  assert.match(validateFlowPayload({ ...valid, guest_email: 'invalid-email' }).error, /A valid email is required/);

  // Invalid phone number
  assert.match(validateFlowPayload({ ...valid, whatsapp_number: '123' }).error, /Please enter a valid mobile number/);
});

test('1. Valid Flow submission converts event into a pending enquiry and marks event PROCESSED', async () => {
  const mockDb = createMockDb();
  const event = createValidEvent();

  const result = await convertFlowInboxEventToEnquiry({
    event,
    workerId: 'worker-unit-01',
    dbPool: mockDb
  });

  assert.equal(result.success, true);
  assert.ok(result.enquiry);
  assert.equal(result.enquiry.status, 'NEW');
  assert.equal(result.enquiry.document_verification_status, 'PENDING');
  assert.equal(result.enquiry.source, 'WHATSAPP');
  assert.equal(result.replayed, false);

  // Verify event was marked processed in database
  const updateQuery = mockDb.executedQueries.find(q => q.sql.includes('UPDATE whatsapp_inbound_events'));
  assert.ok(updateQuery, 'Must execute UPDATE on whatsapp_inbound_events');
  assert.ok(updateQuery.sql.includes("SET processing_status = 'PROCESSED'"));
});

test('2. Invalid or missing fields reject without database write and mark event FAILED', async () => {
  const mockDb = createMockDb();
  const event = createValidEvent({
    payload: {
      property_id: '1',
      check_in: '2026-11-01',
      check_out: '2026-11-03',
      // missing guest_name and whatsapp_number
      guest_email: 'jane@example.com'
    }
  });

  const result = await convertFlowInboxEventToEnquiry({
    event,
    workerId: 'worker-unit-01',
    dbPool: mockDb
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /Missing required fields/);

  // No enquiry inserted
  const enquiryInsert = mockDb.executedQueries.find(q => q.sql.includes('INSERT INTO enquiries'));
  assert.equal(enquiryInsert, undefined, 'Must not insert enquiry on validation failure');

  // Event marked FAILED
  const updateQuery = mockDb.executedQueries.find(q => q.sql.includes('UPDATE whatsapp_inbound_events'));
  assert.ok(updateQuery.sql.includes("processing_status = CASE WHEN retry_count + 1 >="));
});

test('3. Inactive or non-existent property rejects enquiry creation and marks event FAILED', async () => {
  const mockDb = createMockDb({ propertyInactive: true });
  const event = createValidEvent();

  const result = await convertFlowInboxEventToEnquiry({
    event,
    workerId: 'worker-unit-01',
    dbPool: mockDb
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /Property is unavailable or cannot accommodate these guests/);

  // No enquiry inserted
  assert.equal(mockDb.existingEnquiry, null);
});

test('4. Reversed dates (check_out <= check_in) reject before database write', async () => {
  const mockDb = createMockDb();
  const event = createValidEvent({
    payload: {
      ...createValidEvent().payload,
      check_in: '2026-11-05',
      check_out: '2026-11-01'
    }
  });

  const result = await convertFlowInboxEventToEnquiry({
    event,
    workerId: 'worker-unit-01',
    dbPool: mockDb
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /check_out must be after check_in/);

  // No enquiry inserted
  assert.equal(mockDb.existingEnquiry, null);
});

test('5. Excessive guest count exceeding property max_guests rejects with 409', async () => {
  const mockDb = createMockDb();
  const event = createValidEvent({
    payload: {
      ...createValidEvent().payload,
      adults: 20 // Max is 8
    }
  });

  const result = await convertFlowInboxEventToEnquiry({
    event,
    workerId: 'worker-unit-01',
    dbPool: mockDb
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /Property is unavailable or cannot accommodate these guests/);
});

test('6. Duplicate delivery is idempotent and reuses existing enquiry without duplicate creation', async () => {
  const event = createValidEvent();
  const key = enquiryKey({ flow_token: event.payload.flow_token });

  const email = event.payload.guest_email.toLowerCase();
  const phone = '+919876543210';
  const hash = crypto.createHash('sha256').update(JSON.stringify({
    property_id: String(event.payload.property_id),
    check_in: event.payload.check_in,
    check_out: event.payload.check_out,
    adults: Number(event.payload.adults),
    children: Number(event.payload.children || 0),
    infants: Number(event.payload.infants || 0),
    pets: Number(event.payload.pets || 0),
    guest_name: event.payload.guest_name.trim(),
    guest_email: email,
    whatsapp_number: phone,
    special_requests: event.payload.special_requests.trim()
  })).digest('hex');

  const initialEnquiry = {
    id: 88,
    guest_id: 7,
    status: 'NEW',
    document_verification_status: 'PENDING',
    source: 'WHATSAPP',
    integration_idempotency_key: key,
    integration_request_hash: hash
  };

  const mockDb = createMockDb({ initialEnquiry });

  const result = await convertFlowInboxEventToEnquiry({
    event,
    workerId: 'worker-unit-01',
    dbPool: mockDb
  });

  assert.equal(result.success, true);
  assert.equal(result.enquiry.id, 88);
  assert.equal(result.replayed, true);

  // Assert no new enquiry insert was executed
  const insertEnquiryQueries = mockDb.executedQueries.filter(q => q.sql.includes('INSERT INTO enquiries'));
  assert.equal(insertEnquiryQueries.length, 0, 'Must not insert a new enquiry when idempotency key matches');
});

test('7. Database transaction failure triggers ROLLBACK and marks event FAILED', async () => {
  const mockDb = createMockDb({
    simulateErrorTarget: 'INSERT INTO enquiries',
    simulateErrorMessage: 'Simulated disk full or foreign key constraint error'
  });

  const event = createValidEvent();

  const result = await convertFlowInboxEventToEnquiry({
    event,
    workerId: 'worker-unit-01',
    dbPool: mockDb
  });

  assert.equal(result.success, false);
  assert.match(result.error, /Simulated disk full/);

  // Verify ROLLBACK was issued
  const rollbackQuery = mockDb.executedQueries.find(q => q.sql === 'ROLLBACK');
  assert.ok(rollbackQuery, 'Transaction must execute ROLLBACK on error');

  // Event marked FAILED
  const updateQuery = mockDb.executedQueries.find(q => q.sql.includes('UPDATE whatsapp_inbound_events'));
  assert.ok(updateQuery, 'Must update event to failed');
});

test('8. Non-Flow events are rejected without modifying database or creating enquiries', async () => {
  const mockDb = createMockDb();
  const textEvent = {
    id: '102',
    event_kind: 'message',
    event_type: 'text',
    payload: {}
  };

  const result = await convertFlowInboxEventToEnquiry({
    event: textEvent,
    workerId: 'worker-unit-01',
    dbPool: mockDb
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'NOT_A_FLOW_COMPLETION_EVENT');
  assert.equal(mockDb.executedQueries.length, 0, 'Must not touch database for non-Flow events');
});

test('9. Existing enquiry created by Meta Flow Data Exchange is safely matched and reused', async () => {
  const event = createValidEvent();
  const flowToken = event.payload.flow_token;
  const key = enquiryKey({ flow_token: flowToken });

  // Simulate Data Exchange having already run and saved APP-99
  const dataExchangeEnquiry = {
    id: 99,
    guest_id: 12,
    status: 'NEW',
    document_verification_status: 'PENDING',
    source: 'WHATSAPP',
    integration_idempotency_key: key,
    integration_request_hash: crypto.createHash('sha256').update(JSON.stringify({
      property_id: '1',
      check_in: '2026-11-01',
      check_out: '2026-11-03',
      adults: 2,
      children: 1,
      infants: 0,
      pets: 0,
      guest_name: 'Jane Doe',
      guest_email: 'jane@example.com',
      whatsapp_number: '+919876543210',
      special_requests: 'Quiet room please'
    })).digest('hex')
  };

  const mockDb = createMockDb({ initialEnquiry: dataExchangeEnquiry });

  const result = await convertFlowInboxEventToEnquiry({
    event,
    workerId: 'worker-unit-01',
    dbPool: mockDb
  });

  assert.equal(result.success, true);
  assert.equal(result.enquiry.id, 99);
  assert.equal(result.replayed, true);
});

test('10. Preservation of approval/KYC safeguards: enquiry is NEW/PENDING and cannot be approved without verified document', async () => {
  const mockDb = createMockDb();
  const event = createValidEvent();

  const result = await convertFlowInboxEventToEnquiry({
    event,
    workerId: 'worker-unit-01',
    dbPool: mockDb
  });

  assert.equal(result.success, true);
  const enquiry = result.enquiry;

  // 1. Status is strictly NEW and document verification is PENDING
  assert.equal(enquiry.status, 'NEW');
  assert.equal(enquiry.document_verification_status, 'PENDING');

  // 2. Verify with enquiryWorkflow.service that approval is rejected
  assert.throws(
    () => validateApproval({
      currentStatus: enquiry.status,
      documentPath: null,
      documentVerificationStatus: enquiry.document_verification_status
    }),
    error => {
      assert.equal(error.code, 'DOCUMENT_VERIFICATION_REQUIRED');
      assert.equal(error.status, 409);
      return true;
    }
  );
});

test('11. Worker lease ownership is enforced: lost lease returns failure reason', async () => {
  // Simulate ownership lost in database (0 rows updated by worker)
  const mockDb = createMockDb({ simulateOwnershipLost: true });
  const event = createValidEvent();

  const result = await convertFlowInboxEventToEnquiry({
    event,
    workerId: 'worker-unit-01',
    dbPool: mockDb
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'LEASE_LOST_OR_EVENT_NOT_PROCESSING');
});

test('12. Worker does not own the lease pre-check returns WORKER_DOES_NOT_OWN_LEASE', async () => {
  const mockDb = createMockDb();
  const event = createValidEvent({ locked_by: 'worker-someone-else' });

  const result = await convertFlowInboxEventToEnquiry({
    event,
    workerId: 'worker-unit-01',
    dbPool: mockDb
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'WORKER_DOES_NOT_OWN_LEASE');
  assert.equal(mockDb.executedQueries.length, 0);
});
