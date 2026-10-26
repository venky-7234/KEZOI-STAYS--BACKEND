const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  isWorkerEnabled,
  generateWorkerId,
  createWorker
} = require('../src/workers/whatsappInbox.worker');
const { enquiryKey } = require('../src/services/metaFlowBooking.service');

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
  public_description: 'Private city villa',
  public_location: 'Manikonda, Hyderabad',
  public_amenities: ['Wi-Fi', 'Kitchen']
};

/**
 * Creates an in-memory mock PostgreSQL pool for testing the background worker.
 * @param {object} [options]
 * @returns {object}
 */
const createWorkerMockDb = (options = {}) => {
  const executedQueries = [];
  let existingEnquiry = options.initialEnquiry || null;
  let clientReleased = false;

  let queue = options.initialQueue ? [...options.initialQueue] : [];

  const client = {
    queries: executedQueries,
    query: async (sql, params = []) => {
      executedQueries.push({ sql, params });

      // Simulated connection or query error
      if (options.simulateError && (!options.simulateErrorTarget || sql.includes(options.simulateErrorTarget))) {
        throw new Error(options.simulateErrorMessage || 'Simulated database failure');
      }

      // claimNextPendingEvent query
      if (sql.includes('UPDATE whatsapp_inbound_events') && sql.includes('FOR UPDATE SKIP LOCKED')) {
        if (queue.length === 0) {
          return { rows: [], rowCount: 0 };
        }
        const event = queue.shift();
        event.processing_status = 'PROCESSING';
        event.locked_by = params[0];
        event.locked_at = new Date();
        return { rows: [event], rowCount: 1 };
      }

      // Mark event PROCESSED / FAILED / IGNORED
      if (sql.includes('UPDATE whatsapp_inbound_events') && !sql.includes('FOR UPDATE SKIP LOCKED')) {
        if (options.simulateOwnershipLost) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ id: params[0], status: 'UPDATED' }], rowCount: 1 };
      }

      // Enquiry idempotency key check
      if (sql.includes('integration_idempotency_key=$1')) {
        if (existingEnquiry && existingEnquiry.integration_idempotency_key === params[0]) {
          return { rows: [existingEnquiry], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // Advisory lock
      if (sql.includes('pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 0 };
      }

      // Properties search
      if (sql.includes('FROM properties p')) {
        if (options.propertyInactive) {
          return { rows: [], rowCount: 0 };
        }
        const occupantCount = Number(params[2]);
        if (occupantCount > defaultProperty.max_guests) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ ...defaultProperty }], rowCount: 1 };
      }

      // Property by id
      if (sql.includes('FROM properties WHERE id=')) {
        if (options.propertyInactive) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ ...defaultProperty }], rowCount: 1 };
      }

      // Guest queries
      if (sql.includes('SELECT * FROM guests')) {
        return { rows: [{ id: 7, full_name: 'Test Guest', email: 'test@example.com' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO guests')) {
        return { rows: [{ id: 7, full_name: params[0], email: params[1] }], rowCount: 1 };
      }

      // Insert enquiry
      if (sql.includes('INSERT INTO enquiries')) {
        existingEnquiry = {
          id: 55,
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

      // Insert follow-up
      if (sql.includes('INSERT INTO whatsapp_message_follow_ups')) {
        return {
          rows: [{
            id: 88,
            inbound_event_id: params[0],
            idempotency_key: params[1],
            meta_message_id: params[2],
            sender_phone_masked: params[3],
            sender_phone_hash: params[4],
            follow_up_status: 'PENDING',
            is_new_insert: true
          }],
          rowCount: 1
        };
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
    get queue() {
      return queue;
    },
    set queue(val) {
      queue = val;
    },
    get isReleased() {
      return clientReleased;
    },
    get existingEnquiry() {
      return existingEnquiry;
    },
    executedQueries
  };
};

const createMockFlowEvent = (id = '201', overrides = {}) => ({
  id,
  event_kind: 'message',
  meta_message_id: `wamid.HBgL${id}==`,
  event_type: 'interactive_nfm_reply',
  sender_phone_masked: '***3210',
  sender_phone_hash: 'a1b2c3d4e5f6',
  processing_status: 'PENDING',
  retry_count: 0,
  max_retries: 5,
  payload: {
    flow_token: `token-flow-${id}`,
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
    special_requests: 'Ground floor'
  },
  ...overrides
});

// ============================================================================
// TESTS
// ============================================================================

test('worker activation defaults to disabled unless explicitly enabled', () => {
  const origEnv = process.env.ENABLE_WHATSAPP_INBOX_WORKER;

  delete process.env.ENABLE_WHATSAPP_INBOX_WORKER;
  assert.equal(isWorkerEnabled(), false);

  const disabledWorker = createWorker();
  const startRes = disabledWorker.start();
  assert.equal(startRes.started, false);
  assert.equal(startRes.reason, 'DISABLED_BY_CONFIGURATION');
  assert.equal(disabledWorker.isRunning, false);

  process.env.ENABLE_WHATSAPP_INBOX_WORKER = 'true';
  assert.equal(isWorkerEnabled(), true);

  // Restore env
  if (origEnv !== undefined) {
    process.env.ENABLE_WHATSAPP_INBOX_WORKER = origEnv;
  } else {
    delete process.env.ENABLE_WHATSAPP_INBOX_WORKER;
  }
});

test('generateWorkerId produces unique identifiers per instance even if WORKER_ID is configured', () => {
  const id1 = generateWorkerId('test-worker');
  const id2 = generateWorkerId('test-worker');
  assert.match(id1, /^test-worker-\d+-[a-f0-9]+$/);
  assert.match(id2, /^test-worker-\d+-[a-f0-9]+$/);
  assert.notEqual(id1, id2);

  // Even if an operator configures an identical WORKER_ID across multiple pods
  process.env.WORKER_ID = 'cluster-shared-worker';
  const custom1 = generateWorkerId();
  const custom2 = generateWorkerId();
  delete process.env.WORKER_ID;

  assert.match(custom1, /^cluster-shared-worker-\d+-[a-f0-9]+$/);
  assert.match(custom2, /^cluster-shared-worker-\d+-[a-f0-9]+$/);
  assert.notEqual(custom1, custom2);
});

test('1. Successful Flow event processing converts event to enquiry and marks PROCESSED', async () => {
  const flowEvent = createMockFlowEvent('301');
  const mockDb = createWorkerMockDb({ initialQueue: [flowEvent] });

  const worker = createWorker({
    workerId: 'worker-test-01',
    dbPool: mockDb,
    forceEnable: true
  });

  const outcome = await worker.tick();

  assert.equal(outcome.processed, true);
  assert.equal(outcome.eventId, '301');
  assert.equal(outcome.eventKind, 'flow');
  assert.equal(outcome.result.success, true);
  assert.equal(outcome.result.enquiry.status, 'NEW');
  assert.equal(outcome.result.enquiry.document_verification_status, 'PENDING');

  // Verify event update in database
  const processedUpdate = mockDb.executedQueries.find(
    q => q.sql.includes('UPDATE whatsapp_inbound_events') && q.sql.includes("SET processing_status = 'PROCESSED'")
  );
  assert.ok(processedUpdate, 'Must execute UPDATE with processing_status = PROCESSED');
  assert.equal(processedUpdate.params[1], 'worker-test-01', 'Must pass workerId for ownership verification');
});

test('2. Unsupported event (media / status) marks event IGNORED without creating enquiries', async () => {
  const mediaEvent = {
    id: '302',
    event_kind: 'message',
    meta_message_id: 'wamid.MEDIA01',
    event_type: 'image',
    processing_status: 'PENDING',
    payload: { mime_type: 'image/jpeg', has_media_id: true }
  };

  const mockDb = createWorkerMockDb({ initialQueue: [mediaEvent] });
  const worker = createWorker({
    workerId: 'worker-test-01',
    dbPool: mockDb,
    forceEnable: true
  });

  const outcome = await worker.tick();

  assert.equal(outcome.processed, true);
  assert.equal(outcome.eventId, '302');
  assert.equal(outcome.eventKind, 'non-flow');
  assert.equal(outcome.result.success, true);

  // Assert no enquiry was created
  assert.equal(mockDb.existingEnquiry, null);

  // Assert marked IGNORED
  const ignoredUpdate = mockDb.executedQueries.find(
    q => q.sql.includes('UPDATE whatsapp_inbound_events') && q.sql.includes("SET processing_status = 'IGNORED'")
  );
  assert.ok(ignoredUpdate, 'Must mark media event IGNORED');
});

test('2b. Ordinary inbound text message ("Hi") routes to follow-up workflow and marks PROCESSED', async () => {
  const textEvent = {
    id: '302b',
    event_kind: 'message',
    meta_message_id: 'wamid.TXT01',
    event_type: 'text',
    sender_phone_masked: '***3210',
    sender_phone_hash: 'a1b2c3d4e5f6',
    processing_status: 'PENDING',
    payload: {}
  };

  const mockDb = createWorkerMockDb({ initialQueue: [textEvent] });
  const worker = createWorker({
    workerId: 'worker-test-01',
    dbPool: mockDb,
    forceEnable: true
  });

  const outcome = await worker.tick();

  assert.equal(outcome.processed, true);
  assert.equal(outcome.eventId, '302b');
  assert.equal(outcome.eventKind, 'follow-up');
  assert.equal(outcome.result.success, true);
  assert.equal(outcome.result.followUpId, 88);

  // Assert NO enquiry and NO guest was created
  assert.equal(mockDb.existingEnquiry, null);
  const guestInserts = mockDb.executedQueries.filter(q => q.sql.includes('INSERT INTO guests'));
  assert.equal(guestInserts.length, 0);

  // Assert follow-up row was inserted
  const followUpInsert = mockDb.executedQueries.find(q => q.sql.includes('INSERT INTO whatsapp_message_follow_ups'));
  assert.ok(followUpInsert, 'Must insert follow-up record');

  // Assert marked PROCESSED
  const processedUpdate = mockDb.executedQueries.find(
    q => q.sql.includes('UPDATE whatsapp_inbound_events') && q.sql.includes("SET processing_status = 'PROCESSED'")
  );
  assert.ok(processedUpdate, 'Must mark text event PROCESSED');
});

test('3. No eligible events in queue returns without action and allows polling delay', async () => {
  const mockDb = createWorkerMockDb({ initialQueue: [] });
  const worker = createWorker({
    workerId: 'worker-test-01',
    dbPool: mockDb,
    forceEnable: true
  });

  const outcome = await worker.tick();

  assert.equal(outcome.processed, false);
  assert.equal(outcome.reason, 'NO_ELIGIBLE_EVENTS');
  assert.equal(mockDb.existingEnquiry, null);
});

test('4. Temporary database error during claim is safely caught and sanitized without crash', async () => {
  const mockDb = createWorkerMockDb({
    simulateError: true,
    simulateErrorMessage: 'Connection terminated unexpectedly password=SUPER_SECRET_DB_PASSWORD'
  });

  const worker = createWorker({
    workerId: 'worker-test-01',
    dbPool: mockDb,
    forceEnable: true
  });

  const outcome = await worker.tick();

  assert.equal(outcome.processed, false);
  assert.ok(outcome.error);
  // Ensure credentials / secrets are sanitized
  assert.equal(outcome.error.includes('SUPER_SECRET_DB_PASSWORD'), false);
  assert.match(outcome.error, /Connection terminated unexpectedly/);
});

test('5. Retries and dead-letter behavior: business error marks event FAILED with backoff', async () => {
  // Event with excessive guest count (exceeding property max_guests of 8)
  const excessiveGuestsEvent = createMockFlowEvent('305', {
    payload: {
      ...createMockFlowEvent('305').payload,
      adults: 20
    }
  });

  const mockDb = createWorkerMockDb({ initialQueue: [excessiveGuestsEvent] });
  const worker = createWorker({
    workerId: 'worker-test-01',
    dbPool: mockDb,
    forceEnable: true
  });

  const outcome = await worker.tick();

  assert.equal(outcome.processed, true);
  assert.equal(outcome.result.success, false);
  assert.match(outcome.result.error, /Property is unavailable or cannot accommodate these guests/);

  // Event marked FAILED with backoff calculation
  const failedUpdate = mockDb.executedQueries.find(
    q => q.sql.includes('UPDATE whatsapp_inbound_events') && q.sql.includes('retry_count = retry_count + 1')
  );
  assert.ok(failedUpdate, 'Must execute failure backoff update');
  assert.ok(failedUpdate.sql.includes('make_interval'));
});

test('6. Expired lease recovery: worker claims and completes event left by crashed predecessor', async () => {
  // Simulate event stuck in PROCESSING whose 5-minute lease expired
  const expiredEvent = createMockFlowEvent('306', {
    processing_status: 'PROCESSING',
    locked_by: 'worker-crashed-prev',
    locked_at: new Date(Date.now() - 10 * 60 * 1000) // 10 minutes ago
  });

  const mockDb = createWorkerMockDb({ initialQueue: [expiredEvent] });
  const worker = createWorker({
    workerId: 'worker-restarted-02',
    dbPool: mockDb,
    forceEnable: true
  });

  const outcome = await worker.tick();

  assert.equal(outcome.processed, true);
  assert.equal(outcome.result.success, true);

  // Verify the event was reclaimed by the new worker ID
  const claimQuery = mockDb.executedQueries.find(q => q.sql.includes('FOR UPDATE SKIP LOCKED'));
  assert.equal(claimQuery.params[0], 'worker-restarted-02');
});

test('7. Duplicate delivery / replay safety: existing enquiry is reused without duplicate insert', async () => {
  const flowEvent = createMockFlowEvent('307');
  const key = enquiryKey({ flow_token: flowEvent.payload.flow_token });

  const hash = crypto.createHash('sha256').update(JSON.stringify({
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
    special_requests: 'Ground floor'
  })).digest('hex');

  const priorEnquiry = {
    id: 777,
    guest_id: 7,
    status: 'NEW',
    document_verification_status: 'PENDING',
    source: 'WHATSAPP',
    integration_idempotency_key: key,
    integration_request_hash: hash
  };

  const mockDb = createWorkerMockDb({
    initialQueue: [flowEvent],
    initialEnquiry: priorEnquiry
  });

  const worker = createWorker({
    workerId: 'worker-test-01',
    dbPool: mockDb,
    forceEnable: true
  });

  const outcome = await worker.tick();

  assert.equal(outcome.processed, true);
  assert.equal(outcome.result.success, true);
  assert.equal(outcome.result.replayed, true);
  assert.equal(outcome.result.enquiry.id, 777);

  // Verify no INSERT INTO enquiries occurred
  const insertQueries = mockDb.executedQueries.filter(q => q.sql.includes('INSERT INTO enquiries'));
  assert.equal(insertQueries.length, 0);
});

test('8. Lost lease during processing: worker refuses to mark event processed or failed', async () => {
  const flowEvent = createMockFlowEvent('308');
  // Simulate database returning 0 updated rows when worker attempts completion
  const mockDb = createWorkerMockDb({
    initialQueue: [flowEvent],
    simulateOwnershipLost: true
  });

  const worker = createWorker({
    workerId: 'worker-test-01',
    dbPool: mockDb,
    forceEnable: true
  });

  const outcome = await worker.tick();

  assert.equal(outcome.processed, true);
  assert.equal(outcome.result.success, false);
  assert.equal(outcome.result.reason, 'LEASE_LOST_OR_EVENT_NOT_PROCESSING');
});

test('9. Graceful shutdown: worker stops loop cleanly and rejects duplicate concurrent starts', async () => {
  const mockDb = createWorkerMockDb({ initialQueue: [] });
  const worker = createWorker({
    workerId: 'worker-test-01',
    dbPool: mockDb,
    pollIntervalMs: 50,
    forceEnable: true
  });

  // Start worker
  const start1 = worker.start();
  assert.equal(start1.started, true);
  assert.equal(worker.isRunning, true);

  // Calling start while running must return ALREADY_RUNNING
  const start2 = worker.start();
  assert.equal(start2.started, false);
  assert.equal(start2.reason, 'ALREADY_RUNNING');

  // Stop worker gracefully
  const stopRes = await worker.stop();
  assert.equal(stopRes.stopped, true);
  assert.equal(worker.isRunning, false);
});
