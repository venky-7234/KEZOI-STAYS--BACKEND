const GRAPH_API_BASE_URL = 'https://graph.facebook.com';
const DEFAULT_GRAPH_VERSION = 'v21.0';
const VERSION_REGEX = /^v\d+\.\d+$/;

/**
 * Validates and returns the configured Meta Graph API version.
 * @param {string} [customVersion]
 * @returns {string}
 */
const getGraphApiVersion = (customVersion) => {
  const version = customVersion || process.env.WHATSAPP_GRAPH_API_VERSION || DEFAULT_GRAPH_VERSION;
  if (!VERSION_REGEX.test(version)) {
    throw new Error(`Invalid WhatsApp Graph API version: "${version}". Expected format "vXX.X" (e.g. "${DEFAULT_GRAPH_VERSION}").`);
  }
  return version;
};

/**
 * Sanitizes error messages by scrubbing potential access tokens or app secrets.
 * @param {string|Error} error
 * @returns {string}
 */
const sanitizeErrorMessage = (error) => {
  if (!error) return 'Unknown error';
  let message = typeof error === 'string' ? error : (error.message || String(error));

  const accessToken = process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN;
  if (accessToken && accessToken.length > 5) {
    message = message.split(accessToken).join('[REDACTED_ACCESS_TOKEN]');
  }

  const appSecret = process.env.META_APP_SECRET;
  if (appSecret && appSecret.length > 5) {
    message = message.split(appSecret).join('[REDACTED_APP_SECRET]');
  }

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (verifyToken && verifyToken.length > 5) {
    message = message.split(verifyToken).join('[REDACTED_VERIFY_TOKEN]');
  }

  // Scrub any general Bearer tokens
  message = message.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED_TOKEN]');

  // Scrub database passwords and connection URI credentials
  const dbPassword = process.env.DB_PASSWORD;
  if (dbPassword && dbPassword.length > 3) {
    message = message.split(dbPassword).join('[REDACTED_DB_PASSWORD]');
  }
  message = message.replace(/(password\s*=\s*)[^\s&]+/gi, '$1[REDACTED_PASSWORD]');
  message = message.replace(/(:)(\/\/[^:]+:)[^@]+(@)/gi, '$1$2[REDACTED_PASSWORD]$3');

  return message;
};

/**
 * Normalizes phone numbers to digits only, required by WhatsApp Cloud API.
 * e.g., "+91 98765 43210" -> "919876543210"
 * @param {string} phone
 * @returns {string}
 */
const normalizeRecipientPhone = (phone) => {
  if (!phone) throw new Error('Recipient phone number is required');
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) {
    throw new Error('Recipient phone number must contain between 7 and 15 digits');
  }
  return digits;
};

/**
 * Returns configuration readiness without exposing secrets.
 * @returns {object}
 */
const getWhatsAppCloudApiConfiguration = () => {
  const token = process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  let versionValid = false;
  let version = DEFAULT_GRAPH_VERSION;

  try {
    version = getGraphApiVersion();
    versionValid = true;
  } catch (_e) {
    versionValid = false;
  }

  const tokenConfigured = Boolean(token && token.trim().length > 0);
  const phoneNumberIdConfigured = Boolean(phoneNumberId && phoneNumberId.trim().length > 0);

  return {
    configured: tokenConfigured && phoneNumberIdConfigured && versionValid,
    tokenConfigured,
    phoneNumberIdConfigured,
    graphApiVersion: version,
    graphApiVersionValid: versionValid
  };
};

/**
 * Low-level sender to Meta Graph API with bounded retries and rate-limit handling.
 * @param {object} params
 * @param {object} params.payload
 * @param {Function} [params.fetchFn] Optional custom fetch implementation (useful for tests)
 * @param {number} [params.maxRetries=2] Maximum retry attempts for rate limits and transient 5xx errors
 * @param {number} [params.retryDelayMs=300] Delay between retries in milliseconds
 * @returns {Promise<object>}
 */
const postToGraphApi = async ({ payload, fetchFn = fetch, maxRetries = 2, retryDelayMs = 300 }) => {
  const token = process.env.WHATSAPP_CLOUD_API_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !token.trim()) {
    throw new Error('WHATSAPP_CLOUD_API_ACCESS_TOKEN is not configured');
  }
  if (!phoneNumberId || !phoneNumberId.trim()) {
    throw new Error('WHATSAPP_PHONE_NUMBER_ID is not configured');
  }

  const version = getGraphApiVersion();
  const endpoint = `${GRAPH_API_BASE_URL}/${version}/${phoneNumberId.trim()}/messages`;

  let lastError;
  const attempts = Math.max(1, maxRetries + 1);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response;
    try {
      response = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token.trim()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000)
      });
    } catch (networkError) {
      lastError = new Error(sanitizeErrorMessage(`Meta Cloud API request failed: ${networkError.message}`));
      if (attempt < attempts) {
        await new Promise(res => setTimeout(res, retryDelayMs * attempt));
        continue;
      }
      throw lastError;
    }

    let responseBody;
    const rawText = await response.text();
    try {
      responseBody = rawText ? JSON.parse(rawText) : {};
    } catch (_e) {
      responseBody = { raw: rawText };
    }

    if (!response.ok) {
      const errorDetail = responseBody?.error?.message || responseBody?.error?.error_user_msg || `HTTP ${response.status}`;
      const code = responseBody?.error?.code ? ` (code: ${responseBody.error.code})` : '';
      const isRateLimited = response.status === 429 || [80007, 130429, 131056].includes(responseBody?.error?.code);
      const isTransient = [500, 502, 503, 504].includes(response.status);

      lastError = new Error(sanitizeErrorMessage(`Meta WhatsApp Cloud API error: ${errorDetail}${code}`));
      lastError.status = response.status;
      lastError.metaError = responseBody?.error;
      lastError.rawResponse = sanitizeErrorMessage(rawText);
      lastError.isRateLimited = isRateLimited;

      // Retry bounded number of times on rate limits or transient errors
      if ((isRateLimited || isTransient) && attempt < attempts) {
        await new Promise(res => setTimeout(res, retryDelayMs * attempt));
        continue;
      }

      throw lastError;
    }

    return {
      success: true,
      messageId: responseBody?.messages?.[0]?.id,
      response: responseBody
    };
  }

  throw lastError;
};

/**
 * Sends a direct WhatsApp text message to a recipient.
 * @param {object} params
 * @param {string} params.to E.164 or digits-only phone number
 * @param {string} params.text Message body
 * @param {boolean} [params.previewUrl=false]
 * @param {Function} [params.fetchFn]
 * @returns {Promise<object>}
 */
const sendTextMessage = async ({ to, text, previewUrl = false, fetchFn = fetch }) => {
  const recipient = normalizeRecipientPhone(to);
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Message text is required and must be non-empty');
  }

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipient,
    type: 'text',
    text: {
      preview_url: Boolean(previewUrl),
      body: text.trim()
    }
  };

  return postToGraphApi({ payload, fetchFn });
};

/**
 * Sends an interactive WhatsApp Flow message.
 * @param {object} params
 * @param {string} params.to
 * @param {string} params.flowId
 * @param {string} params.flowToken
 * @param {string} [params.flowCta='Book Now'] Button text
 * @param {string} [params.flowMode='published'] 'published' or 'draft'
 * @param {string} [params.flowAction='navigate'] 'navigate' or 'data_exchange'
 * @param {string} [params.screen] Initial screen for navigate action
 * @param {object} [params.data] Initial data payload for navigate action
 * @param {string} [params.headerText] Optional header text
 * @param {string} params.bodyText Main body text
 * @param {string} [params.footerText] Optional footer text
 * @param {Function} [params.fetchFn]
 * @returns {Promise<object>}
 */
const sendFlowMessage = async ({
  to,
  flowId,
  flowToken,
  flowCta = 'Book Now',
  flowMode = 'published',
  flowAction = 'navigate',
  screen,
  data,
  headerText,
  bodyText,
  footerText,
  fetchFn = fetch
}) => {
  const recipient = normalizeRecipientPhone(to);

  if (!flowId || !String(flowId).trim()) {
    throw new Error('flowId is required');
  }
  if (!flowToken || !String(flowToken).trim()) {
    throw new Error('flowToken is required');
  }
  if (typeof bodyText !== 'string' || !bodyText.trim()) {
    throw new Error('bodyText is required and must be non-empty');
  }
  if (!['published', 'draft'].includes(flowMode)) {
    throw new Error('flowMode must be "published" or "draft"');
  }
  if (!['navigate', 'data_exchange'].includes(flowAction)) {
    throw new Error('flowAction must be "navigate" or "data_exchange"');
  }

  const flowActionPayload = {};
  if (screen) flowActionPayload.screen = String(screen).trim();
  if (data && typeof data === 'object') flowActionPayload.data = data;

  const parameters = {
    flow_message_version: '3',
    flow_token: String(flowToken).trim(),
    flow_id: String(flowId).trim(),
    flow_cta: String(flowCta || 'Book Now').trim(),
    flow_action: flowAction,
    mode: flowMode
  };

  // Per Meta Flow Cloud API specification, flow_action_payload is supported only for 'navigate'
  // and must be omitted for 'data_exchange'.
  if (flowAction === 'navigate' && Object.keys(flowActionPayload).length > 0) {
    parameters.flow_action_payload = flowActionPayload;
  }

  const interactive = {
    type: 'flow',
    body: { text: bodyText.trim() },
    action: {
      name: 'flow',
      parameters
    }
  };

  if (headerText && String(headerText).trim()) {
    interactive.header = { type: 'text', text: String(headerText).trim() };
  }
  if (footerText && String(footerText).trim()) {
    interactive.footer = { text: String(footerText).trim() };
  }

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipient,
    type: 'interactive',
    interactive
  };

  return postToGraphApi({ payload, fetchFn });
};

/**
 * Sends an approved WhatsApp Template message.
 * Required for business-initiated conversations outside the 24-hour customer service window.
 * @param {object} params
 * @param {string} params.to Recipient phone number
 * @param {string} params.templateName Approved template name in Meta WhatsApp Manager
 * @param {string} [params.languageCode='en'] Template language code (e.g. 'en', 'en_US', 'hi')
 * @param {Array<object>} [params.components] Optional template parameters/components
 * @param {Function} [params.fetchFn]
 * @returns {Promise<object>}
 */
const sendTemplateMessage = async ({
  to,
  templateName,
  languageCode = 'en',
  components,
  fetchFn = fetch
}) => {
  const recipient = normalizeRecipientPhone(to);

  if (typeof templateName !== 'string' || !templateName.trim()) {
    throw new Error('templateName is required and must be non-empty');
  }

  const template = {
    name: templateName.trim(),
    language: {
      code: String(languageCode || 'en').trim()
    }
  };

  if (Array.isArray(components) && components.length > 0) {
    template.components = components;
  }

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipient,
    type: 'template',
    template
  };

  return postToGraphApi({ payload, fetchFn });
};

module.exports = {
  GRAPH_API_BASE_URL,
  DEFAULT_GRAPH_VERSION,
  getGraphApiVersion,
  sanitizeErrorMessage,
  normalizeRecipientPhone,
  getWhatsAppCloudApiConfiguration,
  postToGraphApi,
  sendTextMessage,
  sendFlowMessage,
  sendTemplateMessage
};
