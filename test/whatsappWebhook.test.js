const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  verifyWebhook,
  handleWebhook,
  timingSafeCompare,
  maskPhoneNumber,
  parseWebhookEvents,
  deduplicationCache
} = require('../src/controllers/whatsappWebhook.controller');
const whatsappRouter = require('../src/routes/whatsapp.routes');
const testWhatsappRouter = require('../src/routes/testWhatsapp.routes');

// Mock response object
const createMockRes = () => {
  return {
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
    },
    json(j) {
      this.body = j;
      return this;
    }
  };
};

test('timingSafeCompare compares strings safely and rejects unequal lengths', () => {
  assert.equal(timingSafeCompare('my-secret-token', 'my-secret-token'), true);
  assert.equal(timingSafeCompare('my-secret-token', 'different-token'), false);
  assert.equal(timingSafeCompare('short', 'longer-token'), false);
  assert.equal(timingSafeCompare('', ''), true);
  assert.equal(timingSafeCompare(null, 'token'), false);
  assert.equal(timingSafeCompare('token', undefined), false);
  assert.equal(timingSafeCompare(123, 123), false);
});

test('maskPhoneNumber redacts phone numbers to only the last 4 digits', () => {
  assert.equal(maskPhoneNumber('+919876543210'), '***3210');
  assert.equal(maskPhoneNumber('919876543210'), '***3210');
  assert.equal(maskPhoneNumber('9876543210'), '***3210');
  assert.equal(maskPhoneNumber('123'), '***');
  assert.equal(maskPhoneNumber(null), 'unknown');
  assert.equal(maskPhoneNumber(''), 'unknown');
});

test('GET /webhook verification succeeds with valid token and mode', () => {
  const originalToken = process.env.WHATSAPP_VERIFY_TOKEN;
  process.env.WHATSAPP_VERIFY_TOKEN = 'kezoi_verify_secret_123';

  const req = {
    query: {
      'hub.mode': 'subscribe',
      'hub.verify_token': 'kezoi_verify_secret_123',
      'hub.challenge': '1158201444'
    }
  };
  const res = createMockRes();

  verifyWebhook(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '1158201444');

  if (originalToken !== undefined) {
    process.env.WHATSAPP_VERIFY_TOKEN = originalToken;
  } else {
    delete process.env.WHATSAPP_VERIFY_TOKEN;
  }
});

test('GET /webhook verification rejects invalid tokens, missing tokens, and wrong modes', () => {
  const originalToken = process.env.WHATSAPP_VERIFY_TOKEN;
  process.env.WHATSAPP_VERIFY_TOKEN = 'kezoi_verify_secret_123';

  // 1. Wrong token
  let req = {
    query: {
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong_token',
      'hub.challenge': '1158201444'
    }
  };
  let res = createMockRes();
  verifyWebhook(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body, 'Forbidden');

  // 2. Wrong mode
  req = {
    query: {
      'hub.mode': 'unsubscribe',
      'hub.verify_token': 'kezoi_verify_secret_123',
      'hub.challenge': '1158201444'
    }
  };
  res = createMockRes();
  verifyWebhook(req, res);
  assert.equal(res.statusCode, 403);

  // 3. Missing verify token
  req = {
    query: {
      'hub.mode': 'subscribe',
      'hub.challenge': '1158201444'
    }
  };
  res = createMockRes();
  verifyWebhook(req, res);
  assert.equal(res.statusCode, 403);

  // 4. WHATSAPP_VERIFY_TOKEN not configured in environment
  delete process.env.WHATSAPP_VERIFY_TOKEN;
  req = {
    query: {
      'hub.mode': 'subscribe',
      'hub.verify_token': 'any_token',
      'hub.challenge': '1158201444'
    }
  };
  res = createMockRes();
  verifyWebhook(req, res);
  assert.equal(res.statusCode, 403);

  if (originalToken !== undefined) {
    process.env.WHATSAPP_VERIFY_TOKEN = originalToken;
  }
});

test('POST /webhook validates X-Hub-Signature-256 against raw body bytes', async () => {
  const originalSecret = process.env.META_APP_SECRET;
  process.env.META_APP_SECRET = 'app_secret_test_987';

  const payload = {
    object: 'whatsapp_business_account',
    entry: []
  };
  const rawBody = Buffer.from(JSON.stringify(payload));
  const validSignature = `sha256=${crypto.createHmac('sha256', process.env.META_APP_SECRET).update(rawBody).digest('hex')}`;

  // Valid signature
  const validReq = {
    headers: { 'x-hub-signature-256': validSignature },
    rawBody,
    body: payload
  };
  const validRes = createMockRes();
  await handleWebhook(validReq, validRes);
  assert.equal(validRes.statusCode, 200);
  assert.equal(validRes.body, 'EVENT_RECEIVED');

  // Invalid signature
  const invalidReq = {
    headers: { 'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000' },
    rawBody,
    body: payload
  };
  const invalidRes = createMockRes();
  await handleWebhook(invalidReq, invalidRes);
  assert.equal(invalidRes.statusCode, 432);
  assert.equal(invalidRes.body, 'Invalid signature');

  // Missing signature header
  const missingHeaderReq = {
    headers: {},
    rawBody,
    body: payload
  };
  const missingHeaderRes = createMockRes();
  await handleWebhook(missingHeaderReq, missingHeaderRes);
  assert.equal(missingHeaderRes.statusCode, 432);

  // Tampered rawBody
  const tamperedReq = {
    headers: { 'x-hub-signature-256': validSignature },
    rawBody: Buffer.concat([rawBody, Buffer.from(' ')]),
    body: payload
  };
  const tamperedRes = createMockRes();
  await handleWebhook(tamperedReq, tamperedRes);
  assert.equal(tamperedRes.statusCode, 432);

  if (originalSecret !== undefined) {
    process.env.META_APP_SECRET = originalSecret;
  } else {
    delete process.env.META_APP_SECRET;
  }
});

test('POST /webhook fails closed with 432 when req.rawBody is missing or undefined', async () => {
  const originalSecret = process.env.META_APP_SECRET;
  process.env.META_APP_SECRET = 'app_secret_test_rawbody';

  try {
    const payload = { object: 'whatsapp_business_account', entry: [] };
    const req = {
      headers: { 'x-hub-signature-256': 'sha256=abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' },
      rawBody: undefined,
      body: payload
    };
    const res = createMockRes();

    await handleWebhook(req, res);
    assert.equal(res.statusCode, 432);
    assert.equal(res.body, 'Invalid signature');
  } finally {
    if (originalSecret !== undefined) {
      process.env.META_APP_SECRET = originalSecret;
    } else {
      delete process.env.META_APP_SECRET;
    }
  }
});

test('POST /webhook fails closed with 432 when META_APP_SECRET is not configured', async () => {
  const originalSecret = process.env.META_APP_SECRET;
  delete process.env.META_APP_SECRET;

  try {
    const payload = { object: 'whatsapp_business_account', entry: [] };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const req = {
      headers: { 'x-hub-signature-256': 'sha256=abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' },
      rawBody,
      body: payload
    };
    const res = createMockRes();

    await handleWebhook(req, res);
    assert.equal(res.statusCode, 432);
    assert.equal(res.body, 'Invalid signature');
  } finally {
    if (originalSecret !== undefined) {
      process.env.META_APP_SECRET = originalSecret;
    }
  }
});

test('router separation isolates production webhook routes from diagnostic test routes', () => {
  const whatsappRoutes = whatsappRouter.stack
    .filter(r => r.route)
    .map(r => ({ path: r.route.path, methods: Object.keys(r.route.methods) }));

  const testRoutes = testWhatsappRouter.stack
    .filter(r => r.route)
    .map(r => ({ path: r.route.path, methods: Object.keys(r.route.methods) }));

  // Production webhook router must ONLY contain /webhook (GET, POST)
  assert.equal(whatsappRoutes.some(r => r.path === '/webhook'), true);
  assert.equal(whatsappRoutes.some(r => r.path === '/'), false);

  // Diagnostic test router must ONLY contain / (POST)
  assert.equal(testRoutes.some(r => r.path === '/'), true);
  assert.equal(testRoutes.some(r => r.path === '/webhook'), false);
});


test('parseWebhookEvents safely extracts text, interactive, media, and status events', () => {
  const samplePayload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_12345',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15550269876',
                phone_number_id: '10987654321'
              },
              messages: [
                {
                  from: '919876543210',
                  id: 'wamid.HBgTEST01',
                  timestamp: '1729760001',
                  text: { body: 'Hello Kezoi Stays' },
                  type: 'text'
                },
                {
                  from: '919876543210',
                  id: 'wamid.HBgTEST02',
                  timestamp: '1729760002',
                  type: 'interactive',
                  interactive: {
                    type: 'nfm_reply',
                    nfm_reply: {
                      name: 'kezoi_booking_flow',
                      response_json: '{"property_id":"1","flow_token":"sensitive_token"}'
                    }
                  }
                },
                {
                  from: '919876543210',
                  id: 'wamid.HBgTEST03',
                  timestamp: '1729760003',
                  type: 'image',
                  image: {
                    id: 'media_id_999',
                    mime_type: 'image/jpeg'
                  }
                }
              ],
              statuses: [
                {
                  id: 'wamid.HBgTEST01',
                  status: 'delivered',
                  timestamp: '1729760005',
                  recipient_id: '919876543210'
                }
              ]
            },
            field: 'messages'
          }
        ]
      }
    ]
  };

  const events = parseWebhookEvents(samplePayload);
  assert.equal(events.length, 4);

  // Message 1: text
  assert.equal(events[0].kind, 'message');
  assert.equal(events[0].id, 'wamid.HBgTEST01');
  assert.equal(events[0].type, 'text');
  assert.equal(events[0].fromMasked, '***3210');
  // Confirm body text is NOT stored in the extracted event object
  assert.equal(events[0].body, undefined);

  // Message 2: interactive flow reply
  assert.equal(events[1].kind, 'message');
  assert.equal(events[1].id, 'wamid.HBgTEST02');
  assert.equal(events[1].type, 'interactive');
  assert.equal(events[1].interactiveType, 'nfm_reply');
  assert.equal(events[1].flowName, 'kezoi_booking_flow');
  // Confirm flow response_json is NOT stored
  assert.equal(events[1].response_json, undefined);

  // Message 3: media image
  assert.equal(events[2].kind, 'message');
  assert.equal(events[2].id, 'wamid.HBgTEST03');
  assert.equal(events[2].type, 'image');
  assert.equal(events[2].mimeType, 'image/jpeg');
  assert.equal(events[2].hasMediaId, true);

  // Status 1: delivered
  assert.equal(events[3].kind, 'status');
  assert.equal(events[3].id, 'wamid.HBgTEST01');
  assert.equal(events[3].status, 'delivered');
  assert.equal(events[3].recipientMasked, '***3210');
});

test('parseWebhookEvents safely handles malformed, empty, or unknown event structures without crashing', () => {
  assert.deepEqual(parseWebhookEvents(null), []);
  assert.deepEqual(parseWebhookEvents(undefined), []);
  assert.deepEqual(parseWebhookEvents({}), []);
  assert.deepEqual(parseWebhookEvents({ object: 'instagram' }), []);
  assert.deepEqual(parseWebhookEvents({ object: 'whatsapp_business_account', entry: [] }), []);
  assert.deepEqual(parseWebhookEvents({ object: 'whatsapp_business_account', entry: [{ changes: [] }] }), []);
  assert.deepEqual(parseWebhookEvents({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messaging_product: 'other_product' } }] }]
  }), []);
  assert.deepEqual(parseWebhookEvents({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messaging_product: 'whatsapp', messages: [{ type: 'unknown_type' }] } }] }]
  }), []);
});

test('deduplication cache ignores duplicate deliveries of the same message ID', async () => {
  deduplicationCache.clear();
  const testId = `wamid.DUP_TEST_${Date.now()}`;
  const key = `msg:${testId}`;

  assert.equal(deduplicationCache.isDuplicate(key), false);
  deduplicationCache.track(key);
  assert.equal(deduplicationCache.isDuplicate(key), true);
});

test('webhook event logs redact sensitive fields and do not leak customer PII', async () => {
  const originalSecret = process.env.META_APP_SECRET;
  process.env.META_APP_SECRET = 'app_secret_test_redact';

  const loggedMessages = [];
  const originalLog = console.log;
  console.log = (...args) => {
    loggedMessages.push(args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
  };

  try {
    const sensitivePhone = '919876543210';
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_1',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                messages: [
                  {
                    from: sensitivePhone,
                    id: `wamid.LOGTEST_${Date.now()}`,
                    timestamp: '1729760000',
                    type: 'text',
                    text: { body: 'This is my private message content' }
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

    await handleWebhook(req, res, { inboxService: { insertInboundEvents: async () => ({ success: true }) } });
    assert.equal(res.statusCode, 200);

    const logOutput = loggedMessages.join('\n');
    // Ensure the raw unmasked phone is NOT in the logs
    assert.equal(logOutput.includes(sensitivePhone), false);
    // Ensure the message body is NOT in the logs
    assert.equal(logOutput.includes('This is my private message content'), false);
    // Ensure the masked phone is present
    assert.equal(logOutput.includes('***3210'), true);
  } finally {
    console.log = originalLog;
    if (originalSecret !== undefined) {
      process.env.META_APP_SECRET = originalSecret;
    } else {
      delete process.env.META_APP_SECRET;
    }
  }
});
