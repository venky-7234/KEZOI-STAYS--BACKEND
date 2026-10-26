const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getGraphApiVersion,
  sanitizeErrorMessage,
  normalizeRecipientPhone,
  getWhatsAppCloudApiConfiguration,
  sendTextMessage,
  sendFlowMessage,
  sendTemplateMessage
} = require('../src/services/whatsappCloudApi.service');

test('getGraphApiVersion validates explicit Meta Graph API version format', () => {
  assert.equal(getGraphApiVersion('v21.0'), 'v21.0');
  assert.equal(getGraphApiVersion('v22.1'), 'v22.1');
  assert.throws(() => getGraphApiVersion('latest'), /Invalid WhatsApp Graph API version/);
  assert.throws(() => getGraphApiVersion('21.0'), /Invalid WhatsApp Graph API version/);
  assert.throws(() => getGraphApiVersion('v21'), /Invalid WhatsApp Graph API version/);
  assert.throws(() => getGraphApiVersion('v21.0; DROP TABLE'), /Invalid WhatsApp Graph API version/);
});

test('normalizeRecipientPhone strips formatting and validates digits length', () => {
  assert.equal(normalizeRecipientPhone('+91 98765 43210'), '919876543210');
  assert.equal(normalizeRecipientPhone('91-98765-43210'), '919876543210');
  assert.equal(normalizeRecipientPhone('15550269876'), '15550269876');
  assert.throws(() => normalizeRecipientPhone(''), /Recipient phone number is required/);
  assert.throws(() => normalizeRecipientPhone(null), /Recipient phone number is required/);
  assert.throws(() => normalizeRecipientPhone('123'), /must contain between 7 and 15 digits/);
});

test('sanitizeErrorMessage scrubs access tokens, secrets, verify tokens and Bearer headers', () => {
  const originalToken = process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN;
  const originalSecret = process.env.META_APP_SECRET;
  const originalVerify = process.env.WHATSAPP_VERIFY_TOKEN;

  process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN = 'EAABtestAccessTokenSecret999';
  process.env.META_APP_SECRET = 'metaAppSecret12345';
  process.env.WHATSAPP_VERIFY_TOKEN = 'verifyTokenSecret777';

  const rawError = 'Failed: token EAABtestAccessTokenSecret999 rejected by secret metaAppSecret12345 with verifyTokenSecret777 and Bearer EAABsomeOtherToken';
  const sanitized = sanitizeErrorMessage(rawError);

  assert.equal(sanitized.includes('EAABtestAccessTokenSecret999'), false);
  assert.equal(sanitized.includes('metaAppSecret12345'), false);
  assert.equal(sanitized.includes('verifyTokenSecret777'), false);
  assert.equal(sanitized.includes('[REDACTED_ACCESS_TOKEN]'), true);
  assert.equal(sanitized.includes('[REDACTED_APP_SECRET]'), true);
  assert.equal(sanitized.includes('[REDACTED_VERIFY_TOKEN]'), true);
  assert.equal(sanitized.includes('[REDACTED_TOKEN]'), true);

  if (originalToken !== undefined) process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN = originalToken; else delete process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN;
  if (originalSecret !== undefined) process.env.META_APP_SECRET = originalSecret; else delete process.env.META_APP_SECRET;
  if (originalVerify !== undefined) process.env.WHATSAPP_VERIFY_TOKEN = originalVerify; else delete process.env.WHATSAPP_VERIFY_TOKEN;
});

test('getWhatsAppCloudApiConfiguration accurately reports readiness without exposing secrets', () => {
  const originalToken = process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN;
  const originalPhone = process.env.WHATSAPP_PHONE_NUMBER_ID;

  process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN = 'test_token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';

  const config = getWhatsAppCloudApiConfiguration();
  assert.equal(config.configured, true);
  assert.equal(config.tokenConfigured, true);
  assert.equal(config.phoneNumberIdConfigured, true);
  assert.equal(config.graphApiVersionValid, true);
  // Ensure token itself is not returned in configuration object
  assert.equal(config.token, undefined);

  delete process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN;
  const notConfigured = getWhatsAppCloudApiConfiguration();
  assert.equal(notConfigured.configured, false);
  assert.equal(notConfigured.tokenConfigured, false);

  if (originalToken !== undefined) process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN = originalToken;
  if (originalPhone !== undefined) process.env.WHATSAPP_PHONE_NUMBER_ID = originalPhone; else delete process.env.WHATSAPP_PHONE_NUMBER_ID;
});

test('sendTextMessage sends valid text payload to Meta Graph API and parses success', async () => {
  const originalToken = process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN;
  const originalPhone = process.env.WHATSAPP_PHONE_NUMBER_ID;

  process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN = 'mock_access_token_123';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '98765432100';

  let capturedUrl = null;
  let capturedHeaders = null;
  let capturedBody = null;

  const mockFetch = async (url, options) => {
    capturedUrl = url;
    capturedHeaders = options.headers;
    capturedBody = JSON.parse(options.body);

    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        messaging_product: 'whatsapp',
        contacts: [{ input: '919876543210', wa_id: '919876543210' }],
        messages: [{ id: 'wamid.HBgMOCKMESSAGE01' }]
      })
    };
  };

  const result = await sendTextMessage({
    to: '+91 98765 43210',
    text: 'Welcome to Kezoi Stays Manikonda!',
    previewUrl: true,
    fetchFn: mockFetch
  });

  assert.equal(capturedUrl, 'https://graph.facebook.com/v21.0/98765432100/messages');
  assert.equal(capturedHeaders.Authorization, 'Bearer mock_access_token_123');
  assert.equal(capturedHeaders['Content-Type'], 'application/json');
  assert.equal(capturedBody.messaging_product, 'whatsapp');
  assert.equal(capturedBody.to, '919876543210');
  assert.equal(capturedBody.type, 'text');
  assert.equal(capturedBody.text.body, 'Welcome to Kezoi Stays Manikonda!');
  assert.equal(capturedBody.text.preview_url, true);

  assert.equal(result.success, true);
  assert.equal(result.messageId, 'wamid.HBgMOCKMESSAGE01');

  if (originalToken !== undefined) process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN = originalToken; else delete process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN;
  if (originalPhone !== undefined) process.env.WHATSAPP_PHONE_NUMBER_ID = originalPhone; else delete process.env.WHATSAPP_PHONE_NUMBER_ID;
});

test('sendTextMessage safely handles Meta Graph API error without exposing tokens', async () => {
  const originalToken = process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN;
  const originalPhone = process.env.WHATSAPP_PHONE_NUMBER_ID;

  process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN = 'secret_bearer_token_xyz';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '98765432100';

  const mockFetchError = async () => {
    return {
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        error: {
          message: 'Unsupported message type with token secret_bearer_token_xyz',
          type: 'OAuthException',
          code: 100,
          fbtrace_id: 'ABc123Trace'
        }
      })
    };
  };

  await assert.rejects(
    async () => {
      await sendTextMessage({
        to: '+91 98765 43210',
        text: 'Test error',
        fetchFn: mockFetchError
      });
    },
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.message.includes('secret_bearer_token_xyz'), false);
      assert.equal(err.message.includes('[REDACTED_ACCESS_TOKEN]'), true);
      assert.equal(err.message.includes('Unsupported message type'), true);
      return true;
    }
  );

  if (originalToken !== undefined) process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN = originalToken; else delete process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN;
  if (originalPhone !== undefined) process.env.WHATSAPP_PHONE_NUMBER_ID = originalPhone; else delete process.env.WHATSAPP_PHONE_NUMBER_ID;
});

test('sendFlowMessage sends valid interactive flow payload and handles options', async () => {
  const originalToken = process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN;
  const originalPhone = process.env.WHATSAPP_PHONE_NUMBER_ID;

  process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN = 'mock_token_flow';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '98765432100';

  let capturedBody = null;

  const mockFetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        messaging_product: 'whatsapp',
        messages: [{ id: 'wamid.HBgFLOWMESSAGE01' }]
      })
    };
  };

  const result = await sendFlowMessage({
    to: '+91 98765 43210',
    flowId: '1149040077692619',
    flowToken: 'flow_token_abc_123',
    flowCta: 'Explore & Book',
    flowMode: 'published',
    flowAction: 'navigate',
    screen: 'BOOKING_DETAILS',
    data: { property_id: '1' },
    headerText: 'Kezoi Stays',
    bodyText: 'Tap below to choose dates and view live availability.',
    footerText: 'Direct booking • Best rate guarantee',
    fetchFn: mockFetch
  });

  assert.equal(result.success, true);
  assert.equal(result.messageId, 'wamid.HBgFLOWMESSAGE01');

  assert.equal(capturedBody.messaging_product, 'whatsapp');
  assert.equal(capturedBody.to, '919876543210');
  assert.equal(capturedBody.type, 'interactive');

  const interactive = capturedBody.interactive;
  assert.equal(interactive.type, 'flow');
  assert.equal(interactive.header.text, 'Kezoi Stays');
  assert.equal(interactive.body.text, 'Tap below to choose dates and view live availability.');
  assert.equal(interactive.footer.text, 'Direct booking • Best rate guarantee');

  const params = interactive.action.parameters;
  assert.equal(params.flow_message_version, '3');
  assert.equal(params.flow_id, '1149040077692619');
  assert.equal(params.flow_token, 'flow_token_abc_123');
  assert.equal(params.flow_cta, 'Explore & Book');
  assert.equal(params.flow_action, 'navigate');
  assert.equal(params.mode, 'published');
  assert.deepEqual(params.flow_action_payload, {
    screen: 'BOOKING_DETAILS',
    data: { property_id: '1' }
  });

  if (originalToken !== undefined) process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN = originalToken; else delete process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN;
  if (originalPhone !== undefined) process.env.WHATSAPP_PHONE_NUMBER_ID = originalPhone; else delete process.env.WHATSAPP_PHONE_NUMBER_ID;
});

test('sendFlowMessage validates required parameters', async () => {
  await assert.rejects(
    async () => sendFlowMessage({ to: '919876543210', flowId: '', flowToken: 'tok', bodyText: 'text' }),
    /flowId is required/
  );
  await assert.rejects(
    async () => sendFlowMessage({ to: '919876543210', flowId: '123', flowToken: '', bodyText: 'text' }),
    /flowToken is required/
  );
  await assert.rejects(
    async () => sendFlowMessage({ to: '919876543210', flowId: '123', flowToken: 'tok', bodyText: '' }),
    /bodyText is required/
  );
  await assert.rejects(
    async () => sendFlowMessage({ to: '919876543210', flowId: '123', flowToken: 'tok', bodyText: 'text', flowMode: 'invalid' }),
    /flowMode must be "published" or "draft"/
  );
  await assert.rejects(
    async () => sendFlowMessage({ to: '919876543210', flowId: '123', flowToken: 'tok', bodyText: 'text', flowAction: 'unsupported' }),
    /flowAction must be "navigate" or "data_exchange"/
  );
});

test('sendFlowMessage with flowAction data_exchange omits flow_action_payload even when screen and data are supplied', async () => {
  const originalToken = process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN;
  const originalPhone = process.env.WHATSAPP_PHONE_NUMBER_ID;

  process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN = 'mock_token_flow_de';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '98765432100';

  let capturedBody = null;
  const mockFetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        messaging_product: 'whatsapp',
        messages: [{ id: 'wamid.FLOW_DATA_EXCHANGE_01' }]
      })
    };
  };

  const result = await sendFlowMessage({
    to: '+91 98765 43210',
    flowId: '1149040077692619',
    flowToken: 'flow_token_abc_123',
    flowCta: 'Explore & Book',
    flowMode: 'published',
    flowAction: 'data_exchange',
    screen: 'BOOKING_DETAILS',
    data: { property_id: '1' },
    bodyText: 'Data exchange test message',
    fetchFn: mockFetch
  });

  assert.equal(result.success, true);
  assert.equal(result.messageId, 'wamid.FLOW_DATA_EXCHANGE_01');

  const params = capturedBody.interactive.action.parameters;
  assert.equal(params.flow_action, 'data_exchange');
  assert.equal(params.flow_action_payload, undefined);
  assert.equal('flow_action_payload' in params, false);

  if (originalToken !== undefined) process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN = originalToken; else delete process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN;
  if (originalPhone !== undefined) process.env.WHATSAPP_PHONE_NUMBER_ID = originalPhone; else delete process.env.WHATSAPP_PHONE_NUMBER_ID;
});

test('sendTextMessage handles non-JSON or HTML error responses from Graph API safely without exposing tokens', async () => {
  const originalToken = process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN;
  const originalPhone = process.env.WHATSAPP_PHONE_NUMBER_ID;

  process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN = 'mock_secret_token_bad_gw';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '98765432100';

  const mockFetchHtmlError = async () => {
    return {
      ok: false,
      status: 502,
      text: async () => '<html><head><title>502 Bad Gateway</title></head><body>502 Bad Gateway with secret mock_secret_token_bad_gw</body></html>'
    };
  };

  await assert.rejects(
    async () => {
      await sendTextMessage({
        to: '+91 98765 43210',
        text: 'Test HTML error handling',
        fetchFn: mockFetchHtmlError
      });
    },
    (err) => {
      assert.equal(err.status, 502);
      assert.equal(err.message.includes('mock_secret_token_bad_gw'), false);
      assert.equal(err.message.includes('HTTP 502'), true);
      assert.equal(err.rawResponse.includes('mock_secret_token_bad_gw'), false);
      assert.equal(err.rawResponse.includes('[REDACTED_ACCESS_TOKEN]'), true);
      assert.equal(err.rawResponse.includes('502 Bad Gateway'), true);
      return true;
    }
  );

  if (originalToken !== undefined) process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN = originalToken; else delete process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN;
  if (originalPhone !== undefined) process.env.WHATSAPP_PHONE_NUMBER_ID = originalPhone; else delete process.env.WHATSAPP_PHONE_NUMBER_ID;
});

test('sendTextMessage handles network failure or timeout safely without exposing tokens', async () => {
  const originalToken = process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN;
  const originalPhone = process.env.WHATSAPP_PHONE_NUMBER_ID;

  process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN = 'mock_secret_token_net_err';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '98765432100';

  const mockFetchNetworkTimeout = async () => {
    const error = new Error('The operation was aborted due to timeout (token: mock_secret_token_net_err)');
    error.name = 'TimeoutError';
    throw error;
  };

  await assert.rejects(
    async () => {
      await sendTextMessage({
        to: '+91 98765 43210',
        text: 'Test network timeout handling',
        fetchFn: mockFetchNetworkTimeout
      });
    },
    (err) => {
      assert.equal(err.message.includes('mock_secret_token_net_err'), false);
      assert.equal(err.message.includes('[REDACTED_ACCESS_TOKEN]'), true);
      assert.equal(err.message.includes('Meta Cloud API request failed:'), true);
      assert.equal(err.message.includes('timeout'), true);
      return true;
    }
  );

  if (originalToken !== undefined) process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN = originalToken; else delete process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN;
  if (originalPhone !== undefined) process.env.WHATSAPP_PHONE_NUMBER_ID = originalPhone; else delete process.env.WHATSAPP_PHONE_NUMBER_ID;
});

test('sendTemplateMessage formats valid template payload and posts to Graph API', async () => {
  const originalToken = process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN;
  const originalPhone = process.env.WHATSAPP_PHONE_NUMBER_ID;

  process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN = 'mock_template_token_123';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '98765432100';

  let capturedBody = null;

  const mockFetch = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        messaging_product: 'whatsapp',
        contacts: [{ input: '919876543210', wa_id: '919876543210' }],
        messages: [{ id: 'wamid.HBgLmockTemplateMessageId' }]
      })
    };
  };

  const response = await sendTemplateMessage({
    to: '+91 98765 43210',
    templateName: 'booking_inquiry_received',
    languageCode: 'en_US',
    components: [
      {
        type: 'body',
        parameters: [{ type: 'text', text: 'Guest Name' }]
      }
    ],
    fetchFn: mockFetch
  });

  assert.equal(response.success, true);
  assert.equal(response.messageId, 'wamid.HBgLmockTemplateMessageId');
  assert.equal(capturedBody.messaging_product, 'whatsapp');
  assert.equal(capturedBody.type, 'template');
  assert.equal(capturedBody.template.name, 'booking_inquiry_received');
  assert.equal(capturedBody.template.language.code, 'en_US');
  assert.equal(capturedBody.template.components.length, 1);

  await assert.rejects(
    async () => {
      await sendTemplateMessage({
        to: '+91 98765 43210',
        templateName: '',
        fetchFn: mockFetch
      });
    },
    /templateName is required and must be non-empty/
  );

  if (originalToken !== undefined) process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN = originalToken; else delete process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN;
  if (originalPhone !== undefined) process.env.WHATSAPP_PHONE_NUMBER_ID = originalPhone; else delete process.env.WHATSAPP_PHONE_NUMBER_ID;
});
