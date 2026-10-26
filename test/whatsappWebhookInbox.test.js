const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  FLOW_ALLOWED_FIELDS,
  hashPhoneNumber,
  normalizeAndAllowlistEvent,
  insertInboundEvents,
  claimNextPendingEvent,
  markEventProcessed,
  markEventFailed
} = require('../src/services/whatsappWebhookInbox.service');
const { handleWebhook } = require('../src/controllers/whatsappWebhook.controller');
const {
  isConfirmationGranted,
  getSafeDatabaseTarget
} = require('../scripts/migrate-whatsapp-webhook-inbox');

// Factory for a mock PostgreSQL pool and client
const createMockPool = (options = {}) => {
  const executedQueries = [];
  let clientReleased = false;

  const mockClient = {
    queries: executedQueries,
    query: async (sql, params = []) => {
      executedQueries.push({ sql, params });

      if (options.queryError && sql.includes(options.queryErrorTarget || 'INSERT')) {
        throw new Error(options.queryError);
      }

      if (sql.includes('INSERT INTO whatsapp_inbound_events')) {
        if (options.simulateDuplicateKey && params[0] === options.simulateDuplicateKey) {
          // ON CONFLICT DO NOTHING returns 0 rows
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ id: '101' }], rowCount: 1 };
      }

      if (sql.includes('UPDATE whatsapp_inbound_events')) {
        if (options.simulateOwnershipLost) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ id: '101', status: 'UPDATED' }], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
    release: () => {
      clientReleased = true;
    }
  };

  return {
    mockClient,
    get isReleased() {
      return clientReleased;
    },
    executedQueries,
    connect: async () => {
      if (options.connectError) {
        throw new Error(options.connectError);
      }
      return mockClient;
    }
  };
};

const createMockRes = () => ({
  statusCode: 200,
  headers: {},
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  type(t) {
    this.headers['content-type'] = t;
    return this;
  },
  send(b) {
    this.body = b;
    return this;
  }
});

test('hashPhoneNumber generates deterministic sha256 hash without storing cleartext digits', () => {
  const hash1 = hashPhoneNumber('+91 98765 43210');
  const hash2 = hashPhoneNumber('919876543210');
  const hash3 = hashPhoneNumber('+919876543211');

  assert.equal(typeof hash1, 'string');
  assert.equal(hash1.length, 64);
  assert.equal(hash1, hash2);
  assert.notEqual(hash1, hash3);
  assert.equal(hashPhoneNumber(null), null);
  assert.equal(hashPhoneNumber(''), null);
});

test('normalizeAndAllowlistEvent filters Flow completion events strictly against allowlist', () => {
  const rawEvent = {
    kind: 'message',
    id: 'wamid.HBgTESTFLOW01',
    timestamp: '1729760000',
    from: '919876543210',
    fromMasked: '***3210',
    type: 'interactive',
    interactiveType: 'nfm_reply',
    flowName: 'kezoi_booking_flow',
    responseJson: JSON.stringify({
      flow_token: 'valid_flow_token_123',
      property_id: '1',
      check_in: '2026-12-10',
      check_out: '2026-12-12',
      adults: '2',
      children: '1',
      infants: '0',
      pets: '0',
      guest_name: 'John Doe',
      guest_email: 'john@example.com',
      whatsapp_number: '+919876543210',
      country_code: 'IN',
      special_requests: 'Quiet room please',
      // Prohibited / unapproved fields that must be stripped:
      secret_access_token: 'EAABsecret123',
      credit_card: '4111222233334444',
      internal_system_id: 9999
    })
  };

  const normalized = normalizeAndAllowlistEvent(rawEvent);

  assert.equal(normalized.idempotency_key, 'msg:wamid.HBgTESTFLOW01');
  assert.equal(normalized.event_kind, 'message');
  assert.equal(normalized.event_type, 'interactive_nfm_reply');
  assert.equal(normalized.processing_status, 'PENDING');
  assert.equal(normalized.sender_phone_masked, '***3210');
  assert.equal(normalized.sender_phone_hash.length, 64);

  const p = normalized.payload;
  assert.equal(p.flow_token, 'valid_flow_token_123');
  assert.equal(p.property_id, '1');
  assert.equal(p.check_in, '2026-12-10');
  assert.equal(p.check_out, '2026-12-12');
  assert.equal(p.adults, 2);
  assert.equal(p.children, 1);
  assert.equal(p.guest_name, 'John Doe');
  assert.equal(p.guest_email, 'john@example.com');
  assert.equal(p.special_requests, 'Quiet room please');

  // Verify prohibited fields were NOT preserved
  assert.equal(p.secret_access_token, undefined);
  assert.equal(p.credit_card, undefined);
  assert.equal(p.internal_system_id, undefined);
});

test('normalizeAndAllowlistEvent excludes free-text bodies and media URLs for data privacy', () => {
  // 1. Text message
  const textEvent = {
    kind: 'message',
    id: 'wamid.HBgTEXT01',
    timestamp: '1729760000',
    from: '919876543210',
    fromMasked: '***3210',
    type: 'text',
    text: { body: 'This private message content must not be persisted' }
  };
  const normText = normalizeAndAllowlistEvent(textEvent);
  assert.equal(normText.event_type, 'text');
  assert.deepEqual(normText.payload, {});
  assert.equal(normText.processing_status, 'PENDING');

  // 2. Media message
  const mediaEvent = {
    kind: 'message',
    id: 'wamid.HBgMEDIA01',
    timestamp: '1729760000',
    from: '919876543210',
    fromMasked: '***3210',
    type: 'image',
    mimeType: 'image/jpeg',
    hasMediaId: true
  };
  const normMedia = normalizeAndAllowlistEvent(mediaEvent);
  assert.equal(normMedia.event_type, 'image');
  assert.equal(normMedia.payload.mime_type, 'image/jpeg');
  assert.equal(normMedia.payload.has_media_id, true);
  assert.equal(normMedia.payload.url, undefined);
  assert.equal(normMedia.processing_status, 'IGNORED');
});

test('status transitions for the same message generate distinct idempotency keys', () => {
  const messageId = 'wamid.STATUS_TEST_01';

  const sentEvent = {
    kind: 'status',
    id: messageId,
    status: 'sent',
    timestamp: '1729760001'
  };
  const deliveredEvent = {
    kind: 'status',
    id: messageId,
    status: 'delivered',
    timestamp: '1729760005'
  };
  const readEvent = {
    kind: 'status',
    id: messageId,
    status: 'read',
    timestamp: '1729760010'
  };

  const normSent = normalizeAndAllowlistEvent(sentEvent);
  const normDelivered = normalizeAndAllowlistEvent(deliveredEvent);
  const normRead = normalizeAndAllowlistEvent(readEvent);

  assert.equal(normSent.idempotency_key, 'status:wamid.STATUS_TEST_01:sent:1729760001');
  assert.equal(normDelivered.idempotency_key, 'status:wamid.STATUS_TEST_01:delivered:1729760005');
  assert.equal(normRead.idempotency_key, 'status:wamid.STATUS_TEST_01:read:1729760010');

  // All 3 idempotency keys are unique from each other
  const uniqueKeys = new Set([normSent.idempotency_key, normDelivered.idempotency_key, normRead.idempotency_key]);
  assert.equal(uniqueKeys.size, 3);
});

test('events lacking an authentic Meta ID are rejected', () => {
  assert.equal(normalizeAndAllowlistEvent({ kind: 'message', id: '', type: 'text' }), null);
  assert.equal(normalizeAndAllowlistEvent({ kind: 'message', id: null, type: 'text' }), null);
  assert.equal(normalizeAndAllowlistEvent({ kind: 'status', id: undefined, status: 'sent' }), null);
});

test('insertInboundEvents persists multiple events atomically inside a single transaction', async () => {
  const mockPool = createMockPool();

  const events = [
    {
      kind: 'message',
      id: 'wamid.BATCH01',
      timestamp: '1729760001',
      from: '919876543210',
      fromMasked: '***3210',
      type: 'text'
    },
    {
      kind: 'status',
      id: 'wamid.BATCH01',
      status: 'delivered',
      timestamp: '1729760002',
      recipient_id: '919876543210'
    }
  ];

  const result = await insertInboundEvents(events, mockPool);

  assert.equal(result.success, true);
  assert.equal(result.insertedCount, 2);
  assert.equal(result.duplicateCount, 0);
  assert.equal(result.total, 2);
  assert.equal(mockPool.isReleased, true);

  const querySqls = mockPool.executedQueries.map(q => q.sql);
  assert.equal(querySqls[0], 'BEGIN');
  assert.equal(querySqls.some(sql => sql.includes('INSERT INTO whatsapp_inbound_events')), true);
  assert.equal(querySqls[querySqls.length - 1], 'COMMIT');
});

test('insertInboundEvents handles duplicates safely via ON CONFLICT DO NOTHING', async () => {
  const mockPool = createMockPool({
    simulateDuplicateKey: 'msg:wamid.DUP01'
  });

  const events = [
    {
      kind: 'message',
      id: 'wamid.DUP01',
      timestamp: '1729760001',
      from: '919876543210',
      type: 'text'
    }
  ];

  const result = await insertInboundEvents(events, mockPool);

  assert.equal(result.success, true);
  assert.equal(result.insertedCount, 0);
  assert.equal(result.duplicateCount, 1);
  assert.equal(mockPool.isReleased, true);

  const querySqls = mockPool.executedQueries.map(q => q.sql);
  assert.equal(querySqls[0], 'BEGIN');
  assert.equal(querySqls[querySqls.length - 1], 'COMMIT');
});

test('insertInboundEvents executes ROLLBACK and releases client if an insert fails', async () => {
  const mockPool = createMockPool({
    queryError: 'unique violation on constraint',
    queryErrorTarget: 'INSERT'
  });

  const events = [
    {
      kind: 'message',
      id: 'wamid.FAIL01',
      timestamp: '1729760001',
      from: '919876543210',
      type: 'text'
    }
  ];

  await assert.rejects(
    async () => insertInboundEvents(events, mockPool),
    (err) => {
      assert.equal(err.isDatabaseError, true);
      assert.equal(err.message.includes('Inbound event persistence failed:'), true);
      return true;
    }
  );

  assert.equal(mockPool.isReleased, true);
  const querySqls = mockPool.executedQueries.map(q => q.sql);
  assert.equal(querySqls[0], 'BEGIN');
  assert.equal(querySqls[querySqls.length - 1], 'ROLLBACK');
});

test('handleWebhook fails closed without calling database when signature is invalid', async () => {
  let dbCalled = false;
  const mockInbox = {
    insertInboundEvents: async () => {
      dbCalled = true;
      return { success: true };
    }
  };

  const req = {
    headers: { 'x-hub-signature-256': 'sha256=invalid' },
    rawBody: Buffer.from('{"test":"payload"}'),
    body: { test: 'payload' }
  };
  const res = createMockRes();

  await handleWebhook(req, res, { inboxService: mockInbox });

  assert.equal(res.statusCode, 432);
  assert.equal(res.body, 'Invalid signature');
  assert.equal(dbCalled, false);
});

test('handleWebhook returns retryable HTTP 500 without leaking database credentials when persistence fails', async () => {
  const originalSecret = process.env.META_APP_SECRET;
  process.env.META_APP_SECRET = 'secret_test_error_handling_123';

  const mockInboxFailure = {
    insertInboundEvents: async () => {
      const err = new Error('getaddrinfo ENOTFOUND secret_db_host:5432 password=SUPER_SECRET_DB_PASSWORD');
      err.isDatabaseError = true;
      throw err;
    }
  };

  try {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                messages: [{ id: 'wamid.FAIL_HTTP500', from: '919876543210', type: 'text' }]
              }
            }
          ]
        }
      ]
    };

    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${crypto.createHmac('sha256', process.env.META_APP_SECRET).update(rawBody).digest('hex')}`;

    const req = {
      headers: { 'x-hub-signature-256': signature },
      rawBody,
      body: payload
    };
    const res = createMockRes();

    await handleWebhook(req, res, { inboxService: mockInboxFailure });

    assert.equal(res.statusCode, 500);
    assert.equal(res.body, 'Internal Server Error');
    // Ensure the response does not expose database hostname, passwords, or error stack
    assert.equal(String(res.body).includes('SUPER_SECRET_DB_PASSWORD'), false);
    assert.equal(String(res.body).includes('secret_db_host'), false);
  } finally {
    if (originalSecret !== undefined) process.env.META_APP_SECRET = originalSecret;
    else delete process.env.META_APP_SECRET;
  }
});

test('handleWebhook returns HTTP 200 EVENT_RECEIVED when persistence commits successfully', async () => {
  const originalSecret = process.env.META_APP_SECRET;
  process.env.META_APP_SECRET = 'secret_test_success_123';

  let persistedEvents = [];
  const mockInboxSuccess = {
    insertInboundEvents: async (events) => {
      persistedEvents = events;
      return { success: true, insertedCount: 1, duplicateCount: 0, total: 1 };
    }
  };

  try {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                messages: [
                  {
                    id: 'wamid.SUCCESS_TEST_01',
                    from: '919876543210',
                    type: 'text',
                    text: { body: 'Hello' }
                  }
                ]
              }
            }
          ]
        }
      ]
    };

    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${crypto.createHmac('sha256', process.env.META_APP_SECRET).update(rawBody).digest('hex')}`;

    const req = {
      headers: { 'x-hub-signature-256': signature },
      rawBody,
      body: payload
    };
    const res = createMockRes();

    await handleWebhook(req, res, { inboxService: mockInboxSuccess });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'EVENT_RECEIVED');
    assert.equal(persistedEvents.length, 1);
    assert.equal(persistedEvents[0].id, 'wamid.SUCCESS_TEST_01');
  } finally {
    if (originalSecret !== undefined) process.env.META_APP_SECRET = originalSecret;
    else delete process.env.META_APP_SECRET;
  }
});

test('claimNextPendingEvent query reclaims expired PROCESSING leases and eligible PENDING/FAILED events', async () => {
  const mockPool = createMockPool();

  const claimed = await claimNextPendingEvent('worker-node-1', mockPool, 5);

  assert.equal(mockPool.isReleased, true);
  assert.equal(claimed.id, '101');
  const query = mockPool.executedQueries[0];
  assert.equal(query.sql.includes('FOR UPDATE SKIP LOCKED'), true);
  // Verifies the query targets eligible PENDING/FAILED AND expired PROCESSING rows
  assert.equal(query.sql.includes("processing_status IN ('PENDING', 'FAILED')"), true);
  assert.equal(query.sql.includes("processing_status = 'PROCESSING'"), true);
  assert.equal(query.sql.includes("make_interval(mins => $2::integer)"), true);
  assert.equal(query.params[0], 'worker-node-1');
  assert.equal(query.params[1], 5);
});

test('claimNextPendingEvent rejects execution when workerId is missing or empty', async () => {
  await assert.rejects(
    async () => claimNextPendingEvent(''),
    /workerId is required to claim an event/
  );
  await assert.rejects(
    async () => claimNextPendingEvent(null),
    /workerId is required to claim an event/
  );
});

test('markEventProcessed verifies worker ownership and returns success: true on active lease', async () => {
  const mockPool = createMockPool();

  const result = await markEventProcessed('101', 'worker-node-1', mockPool);

  assert.equal(mockPool.isReleased, true);
  assert.equal(result.success, true);
  assert.equal(result.event.id, '101');
  const query = mockPool.executedQueries[0];
  assert.equal(query.sql.includes("processing_status = 'PROCESSED'"), true);
  assert.equal(query.sql.includes("WHERE id = $1 AND locked_by = $2 AND processing_status = 'PROCESSING'"), true);
  assert.equal(query.params[0], '101');
  assert.equal(query.params[1], 'worker-node-1');
});

test('markEventProcessed rejects update and returns success: false when worker lease ownership was lost', async () => {
  const mockPool = createMockPool({ simulateOwnershipLost: true });

  const result = await markEventProcessed('101', 'stale-worker-node', mockPool);

  assert.equal(mockPool.isReleased, true);
  assert.equal(result.success, false);
  assert.equal(result.reason, 'LEASE_LOST_OR_EVENT_NOT_PROCESSING');
  assert.equal(result.event, undefined);
});

test('markEventFailed uses type-safe make_interval with bounded backoff and updates row when ownership holds', async () => {
  const mockPool = createMockPool();

  const result = await markEventFailed('101', 'worker-node-1', 'Downstream connection timeout', mockPool, 5);

  assert.equal(mockPool.isReleased, true);
  assert.equal(result.success, true);
  assert.equal(result.event.id, '101');
  const query = mockPool.executedQueries[0];
  assert.equal(query.sql.includes("retry_count = retry_count + 1"), true);
  assert.equal(query.sql.includes("make_interval(mins => POWER(2, LEAST(retry_count + 1, 6))::integer)"), true);
  assert.equal(query.sql.includes("WHERE id = $1 AND locked_by = $2 AND processing_status = 'PROCESSING'"), true);
  assert.equal(query.params[0], '101');
  assert.equal(query.params[1], 'worker-node-1');
  assert.equal(query.params[2], 'Downstream connection timeout');
  assert.equal(query.params[3], 5);
});

test('markEventFailed rejects update and returns success: false when worker lease ownership was lost', async () => {
  const mockPool = createMockPool({ simulateOwnershipLost: true });

  const result = await markEventFailed('101', 'stale-worker-node', 'Some error message', mockPool, 5);

  assert.equal(mockPool.isReleased, true);
  assert.equal(result.success, false);
  assert.equal(result.reason, 'LEASE_LOST_OR_EVENT_NOT_PROCESSING');
  assert.equal(result.event, undefined);
});

test('markEventFailed and markEventProcessed propagate database errors and release client', async () => {
  const mockPool = createMockPool({
    queryError: 'Database connection terminated unexpectedly',
    queryErrorTarget: 'UPDATE'
  });

  await assert.rejects(
    async () => markEventProcessed('101', 'worker-1', mockPool),
    /Database connection terminated unexpectedly/
  );
  assert.equal(mockPool.isReleased, true);

  const mockPool2 = createMockPool({
    queryError: 'Deadlock detected during update',
    queryErrorTarget: 'UPDATE'
  });

  await assert.rejects(
    async () => markEventFailed('101', 'worker-1', 'err', mockPool2, 5),
    /Deadlock detected during update/
  );
  assert.equal(mockPool2.isReleased, true);
});

test('markEventProcessed and markEventFailed validate required eventId and workerId parameters', async () => {
  await assert.rejects(
    async () => markEventProcessed('', 'worker-1'),
    /eventId is required/
  );
  await assert.rejects(
    async () => markEventProcessed('101', ''),
    /workerId is required to verify ownership/
  );
  await assert.rejects(
    async () => markEventFailed('', 'worker-1', 'err'),
    /eventId is required/
  );
  await assert.rejects(
    async () => markEventFailed('101', '', 'err'),
    /workerId is required to verify ownership/
  );
});

test('migration runner safeguard displays target identity without credentials and requires confirmation', () => {
  // 1. Verify safe target identity does NOT contain passwords or secrets
  const target = getSafeDatabaseTarget();
  assert.equal(typeof target.host, 'string');
  assert.equal(typeof target.database, 'string');
  assert.equal(typeof target.user, 'string');
  assert.equal(target.password, undefined);
  assert.equal(target.secret, undefined);

  // 2. Verify confirmation check requires explicit --confirm or CONFIRM_INBOX_MIGRATION
  const originalEnv = process.env.CONFIRM_INBOX_MIGRATION;
  const originalArgv = [...process.argv];

  try {
    delete process.env.CONFIRM_INBOX_MIGRATION;
    process.argv = process.argv.filter(arg => arg !== '--confirm');
    assert.equal(isConfirmationGranted(), false);

    // With environment flag
    process.env.CONFIRM_INBOX_MIGRATION = 'YES';
    assert.equal(isConfirmationGranted(), true);

    // With command-line flag
    delete process.env.CONFIRM_INBOX_MIGRATION;
    process.argv.push('--confirm');
    assert.equal(isConfirmationGranted(), true);
  } finally {
    if (originalEnv !== undefined) process.env.CONFIRM_INBOX_MIGRATION = originalEnv;
    else delete process.env.CONFIRM_INBOX_MIGRATION;
    process.argv = originalArgv;
  }
});
