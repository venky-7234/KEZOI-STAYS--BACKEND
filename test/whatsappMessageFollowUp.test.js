const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isOrdinaryTextMessageEvent,
  processOrdinaryMessageFollowUp,
  listMessageFollowUps,
  updateMessageFollowUp
} = require('../src/services/whatsappMessageFollowUp.service');

/**
 * Creates an in-memory mock database client for testing the follow-up service.
 * @param {object} [options]
 * @returns {object}
 */
const createMockDb = (options = {}) => {
  const executedQueries = [];
  let existingFollowUp = options.initialFollowUp || null;
  let clientReleased = false;

  const client = {
    queries: executedQueries,
    query: async (sql, params = []) => {
      executedQueries.push({ sql, params });

      if (options.simulateError && (!options.simulateErrorTarget || sql.includes(options.simulateErrorTarget))) {
        throw new Error(options.simulateErrorMessage || 'Simulated database failure password=SUPER_SECRET_DB_PASSWORD');
      }

      // Insert or upsert follow-up record
      if (sql.includes('INSERT INTO whatsapp_message_follow_ups')) {
        const isDuplicate = existingFollowUp && existingFollowUp.idempotency_key === params[1];
        if (isDuplicate) {
          existingFollowUp.updated_at = new Date();
          return {
            rows: [{
              ...existingFollowUp,
              is_new_insert: false
            }],
            rowCount: 1
          };
        }

        existingFollowUp = {
          id: 42,
          inbound_event_id: params[0],
          idempotency_key: params[1],
          meta_message_id: params[2],
          sender_phone_masked: params[3],
          sender_phone_hash: params[4],
          follow_up_status: 'PENDING',
          metadata: JSON.parse(params[5] || '{}'),
          created_at: new Date(),
          updated_at: new Date(),
          is_new_insert: true
        };
        return { rows: [existingFollowUp], rowCount: 1 };
      }

      // Update inbound event status (markEventProcessed / markEventFailed)
      if (sql.includes('UPDATE whatsapp_inbound_events')) {
        if (options.simulateOwnershipLost) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ id: params[0], status: 'UPDATED' }], rowCount: 1 };
      }

      // List follow-ups
      if (sql.includes('SELECT') && sql.includes('FROM whatsapp_message_follow_ups')) {
        return {
          rows: existingFollowUp ? [existingFollowUp] : [],
          rowCount: existingFollowUp ? 1 : 0
        };
      }

      // Update follow-up
      if (sql.includes('UPDATE whatsapp_message_follow_ups')) {
        if (!existingFollowUp) return { rows: [], rowCount: 0 };
        existingFollowUp.follow_up_status = params[1] || existingFollowUp.follow_up_status;
        existingFollowUp.assigned_to = params[2] || existingFollowUp.assigned_to;
        existingFollowUp.notes = params[3] || existingFollowUp.notes;
        return { rows: [existingFollowUp], rowCount: 1 };
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
    get isReleased() {
      return clientReleased;
    },
    get existingFollowUp() {
      return existingFollowUp;
    },
    executedQueries
  };
};

// ============================================================================
// TESTS
// ============================================================================

test('isOrdinaryTextMessageEvent accurately classifies ordinary text events and rejects others', () => {
  // Valid text message
  assert.equal(isOrdinaryTextMessageEvent({
    event_kind: 'message',
    event_type: 'text'
  }), true);

  // Flow completion interactive event
  assert.equal(isOrdinaryTextMessageEvent({
    event_kind: 'message',
    event_type: 'interactive_nfm_reply'
  }), false);

  // Status event
  assert.equal(isOrdinaryTextMessageEvent({
    event_kind: 'status',
    event_type: 'delivered'
  }), false);

  // Media image event
  assert.equal(isOrdinaryTextMessageEvent({
    event_kind: 'message',
    event_type: 'image'
  }), false);

  // Null, undefined, empty
  assert.equal(isOrdinaryTextMessageEvent(null), false);
  assert.equal(isOrdinaryTextMessageEvent({}), false);
  assert.equal(isOrdinaryTextMessageEvent('invalid'), false);
});

test('processOrdinaryMessageFollowUp creates a pending follow-up record without creating enquiries or guests', async () => {
  const textEvent = {
    id: '501',
    event_kind: 'message',
    meta_message_id: 'wamid.HBgLTEXTMSG01',
    event_type: 'text',
    sender_phone_masked: '***4321',
    sender_phone_hash: '9f8e7d6c5b4a',
    processing_status: 'PROCESSING',
    locked_by: 'worker-test-alpha',
    payload: {}
  };

  const mockDb = createMockDb();
  const result = await processOrdinaryMessageFollowUp({
    event: textEvent,
    workerId: 'worker-test-alpha',
    dbPool: mockDb
  });

  assert.equal(result.success, true);
  assert.equal(result.followUpId, 42);
  assert.equal(result.replayed, false);
  assert.equal(result.followUp.follow_up_status, 'PENDING');
  assert.equal(result.followUp.sender_phone_masked, '***4321');
  assert.equal(result.followUp.sender_phone_hash, '9f8e7d6c5b4a');

  // Verify that NO guest, enquiry, or booking table was touched
  const guestInserts = mockDb.executedQueries.filter(q => q.sql.includes('INSERT INTO guests'));
  const enquiryInserts = mockDb.executedQueries.filter(q => q.sql.includes('INSERT INTO enquiries'));
  const bookingInserts = mockDb.executedQueries.filter(q => q.sql.includes('INSERT INTO bookings'));
  assert.equal(guestInserts.length, 0);
  assert.equal(enquiryInserts.length, 0);
  assert.equal(bookingInserts.length, 0);

  // Verify that inbound event was marked PROCESSED
  const markProcessed = mockDb.executedQueries.find(
    q => q.sql.includes('UPDATE whatsapp_inbound_events') && q.sql.includes("SET processing_status = 'PROCESSED'")
  );
  assert.ok(markProcessed, 'Inbound event must be marked PROCESSED');
  assert.equal(markProcessed.params[1], 'worker-test-alpha');
  assert.equal(mockDb.isReleased, true);
});

test('processOrdinaryMessageFollowUp is idempotent and handles duplicate delivery without duplicate insert', async () => {
  const textEvent = {
    id: '502',
    event_kind: 'message',
    meta_message_id: 'wamid.DUPLICATE01',
    event_type: 'text',
    sender_phone_masked: '***9999',
    sender_phone_hash: 'hash-duplicate-123',
    processing_status: 'PROCESSING',
    locked_by: 'worker-test-alpha',
    payload: {}
  };

  const initialFollowUp = {
    id: 99,
    inbound_event_id: '502',
    idempotency_key: 'followup:msg:wamid.DUPLICATE01',
    meta_message_id: 'wamid.DUPLICATE01',
    sender_phone_masked: '***9999',
    sender_phone_hash: 'hash-duplicate-123',
    follow_up_status: 'PENDING',
    created_at: new Date('2026-10-26T10:00:00Z'),
    updated_at: new Date('2026-10-26T10:00:00Z')
  };

  const mockDb = createMockDb({ initialFollowUp });
  const result = await processOrdinaryMessageFollowUp({
    event: textEvent,
    workerId: 'worker-test-alpha',
    dbPool: mockDb
  });

  assert.equal(result.success, true);
  assert.equal(result.followUpId, 99);
  assert.equal(result.replayed, true);
});

test('processOrdinaryMessageFollowUp enforces worker lease ownership before processing', async () => {
  const textEvent = {
    id: '503',
    event_kind: 'message',
    meta_message_id: 'wamid.LEASE_TEST_01',
    event_type: 'text',
    processing_status: 'PROCESSING',
    locked_by: 'worker-other-instance', // Belonging to another worker
    payload: {}
  };

  const mockDb = createMockDb();
  const result = await processOrdinaryMessageFollowUp({
    event: textEvent,
    workerId: 'worker-my-instance',
    dbPool: mockDb
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'WORKER_DOES_NOT_OWN_LEASE');
  assert.equal(mockDb.executedQueries.length, 0, 'Must not execute any query when lease is not owned');
});

test('processOrdinaryMessageFollowUp rejects non-text events gracefully', async () => {
  const flowEvent = {
    id: '504',
    event_kind: 'message',
    event_type: 'interactive_nfm_reply',
    payload: { flow_token: 'abc' }
  };

  const mockDb = createMockDb();
  const result = await processOrdinaryMessageFollowUp({
    event: flowEvent,
    workerId: 'worker-test-alpha',
    dbPool: mockDb
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, 'NOT_AN_ORDINARY_TEXT_EVENT');
});

test('processOrdinaryMessageFollowUp catches database errors, sanitizes error message, and marks event FAILED', async () => {
  const textEvent = {
    id: '505',
    event_kind: 'message',
    meta_message_id: 'wamid.ERR_TEST_01',
    event_type: 'text',
    sender_phone_masked: '***1111',
    sender_phone_hash: 'err-hash',
    processing_status: 'PROCESSING',
    locked_by: 'worker-test-alpha',
    payload: {}
  };

  const mockDb = createMockDb({
    simulateError: true,
    simulateErrorTarget: 'INSERT INTO whatsapp_message_follow_ups',
    simulateErrorMessage: 'Connection failed password=SUPER_SECRET_DB_PASSWORD'
  });

  const result = await processOrdinaryMessageFollowUp({
    event: textEvent,
    workerId: 'worker-test-alpha',
    dbPool: mockDb
  });

  assert.equal(result.success, false);
  assert.equal(result.error.includes('SUPER_SECRET_DB_PASSWORD'), false, 'Database password must be scrubbed');
  assert.equal(result.error.includes('[REDACTED_PASSWORD]'), true, 'Password must be redacted');

  // Verify markEventFailed was executed
  const markFailed = mockDb.executedQueries.find(
    q => q.sql.includes('UPDATE whatsapp_inbound_events') && q.sql.includes('retry_count = retry_count + 1')
  );
  assert.ok(markFailed, 'Must record failure with retry backoff');
});

test('listMessageFollowUps and updateMessageFollowUp manage follow-up records safely', async () => {
  const initialFollowUp = {
    id: 77,
    inbound_event_id: '506',
    idempotency_key: 'followup:msg:wamid.STAFF_MGMT',
    meta_message_id: 'wamid.STAFF_MGMT',
    sender_phone_masked: '***5678',
    sender_phone_hash: 'staff-hash',
    follow_up_status: 'PENDING',
    assigned_to: null,
    notes: null,
    created_at: new Date(),
    updated_at: new Date()
  };

  const mockDb = createMockDb({ initialFollowUp });

  // 1. List follow-ups
  const list = await listMessageFollowUps({ status: 'PENDING', limit: 10 }, mockDb);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 77);

  // 2. Update follow-up status to CONTACTED
  const updated = await updateMessageFollowUp(77, {
    follow_up_status: 'CONTACTED',
    assigned_to: 5,
    notes: 'Contacted guest via WhatsApp Business chat'
  }, mockDb);

  assert.equal(updated.follow_up_status, 'CONTACTED');
  assert.equal(updated.assigned_to, 5);
  assert.equal(updated.notes, 'Contacted guest via WhatsApp Business chat');

  // 3. Reject invalid status
  await assert.rejects(
    async () => {
      await updateMessageFollowUp(77, { follow_up_status: 'INVALID_STATUS' }, mockDb);
    },
    /Invalid follow_up_status/
  );
});
