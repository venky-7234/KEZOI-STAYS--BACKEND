const crypto = require('crypto');
const { verifyMetaSignature } = require('../services/metaFlowCrypto.service');
const defaultInboxService = require('../services/whatsappWebhookInbox.service');

// In-memory bounded cache for webhook event deduplication.
// Meta occasionally retries delivery if an acknowledgment takes longer than expected.
class BoundedDeduplicationCache {
  constructor(maxSize = 1000, ttlMs = 15 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }

  isDuplicate(key) {
    if (!key) return false;
    const now = Date.now();
    const entry = this.cache.get(key);
    if (entry) {
      if (now - entry.time < this.ttlMs) {
        return true;
      }
      this.cache.delete(key);
    }
    return false;
  }

  track(key) {
    if (!key) return;
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, { time: Date.now() });
  }

  clear() {
    this.cache.clear();
  }
}

const deduplicationCache = new BoundedDeduplicationCache();

/**
 * Timing-safe string comparison preventing timing attacks.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
const timingSafeCompare = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

/**
 * Masks a phone number to show only the last 4 digits (e.g. "***3210").
 * @param {string|number} phone
 * @returns {string}
 */
const maskPhoneNumber = (phone) => {
  if (!phone) return 'unknown';
  const clean = String(phone).replace(/\D/g, '');
  if (clean.length <= 4) return '***';
  return `***${clean.slice(-4)}`;
};

/**
 * Handles Meta Webhook Verification challenge (GET /api/whatsapp/webhook).
 */
const verifyWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const configuredToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === 'subscribe' && configuredToken && timingSafeCompare(token, configuredToken)) {
    return res.status(200).type('text/plain').send(challenge);
  }

  // Never log the received token. Only log that verification failed.
  console.warn('WhatsApp webhook verification rejected: token mismatch, missing token, or invalid mode');
  return res.status(403).type('text/plain').send('Forbidden');
};

/**
 * Safely parses the webhook payload and extracts minimal redacted metadata.
 * Does not throw on malformed structures.
 * @param {object} body
 * @returns {Array<object>} Extracted redacted events
 */
const parseWebhookEvents = (body) => {
  const events = [];
  if (!body || typeof body !== 'object' || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) {
    return events;
  }

  for (const entry of body.entry) {
    if (!entry || !Array.isArray(entry.changes)) continue;

    for (const change of entry.changes) {
      const value = change?.value;
      if (!value || value.messaging_product !== 'whatsapp') continue;

      // 1. Inbound messages
      if (Array.isArray(value.messages)) {
        for (const message of value.messages) {
          if (!message || !message.id) continue;

          const event = {
            kind: 'message',
            id: message.id,
            timestamp: message.timestamp,
            from: message.from,
            fromMasked: maskPhoneNumber(message.from),
            type: message.type
          };

          if (message.type === 'interactive' && message.interactive) {
            event.interactiveType = message.interactive.type;
            if (message.interactive.type === 'nfm_reply' && message.interactive.nfm_reply) {
              event.flowName = message.interactive.nfm_reply.name || null;
              event.responseJson = message.interactive.nfm_reply.response_json || null;
              event.flowToken = message.interactive.nfm_reply.flow_token || null;
            } else if (message.interactive.type === 'button_reply' && message.interactive.button_reply) {
              event.buttonId = message.interactive.button_reply.id || null;
            } else if (message.interactive.type === 'list_reply' && message.interactive.list_reply) {
              event.listId = message.interactive.list_reply.id || null;
            }
          } else if (['image', 'document', 'audio', 'video'].includes(message.type) && message[message.type]) {
            event.mimeType = message[message.type].mime_type || null;
            event.hasMediaId = Boolean(message[message.type].id);
          }

          events.push(event);
        }
      }

      // 2. Outbound message status updates
      if (Array.isArray(value.statuses)) {
        for (const status of value.statuses) {
          if (!status || !status.id) continue;

          events.push({
            kind: 'status',
            id: status.id,
            status: status.status,
            timestamp: status.timestamp,
            recipient_id: status.recipient_id,
            recipientMasked: maskPhoneNumber(status.recipient_id),
            hasErrors: Array.isArray(status.errors) && status.errors.length > 0,
            errorCode: Array.isArray(status.errors) && status.errors[0]?.code ? status.errors[0].code : null,
            errorTitle: Array.isArray(status.errors) && status.errors[0]?.title ? status.errors[0].title : null
          });
        }
      }
    }
  }

  return events;
};

/**
 * Handles incoming WhatsApp webhook events (POST /api/whatsapp/webhook).
 * Persists all verified events durably in PostgreSQL before returning HTTP 200.
 */
const handleWebhook = async (req, res, customOptions = {}) => {
  const options = (typeof customOptions === 'object' && customOptions !== null && typeof customOptions !== 'function')
    ? customOptions
    : {};

  const signature = req.headers['x-hub-signature-256'];

  if (!verifyMetaSignature(req.rawBody, signature)) {
    console.warn('WhatsApp webhook signature verification failed', {
      signatureHeaderPresent: Boolean(signature),
      rawBodyCaptured: Buffer.isBuffer(req.rawBody)
    });
    return res.status(432).type('text/plain').send('Invalid signature');
  }

  try {
    const rawEvents = parseWebhookEvents(req.body);

    if (rawEvents.length > 0) {
      const inbox = options.inboxService || defaultInboxService;
      await inbox.insertInboundEvents(rawEvents, options.dbPool);

      for (const evt of rawEvents) {
        if (evt.kind === 'message') {
          console.log('WhatsApp webhook message ingested', {
            id: evt.id,
            type: evt.type,
            interactiveType: evt.interactiveType || undefined,
            flowName: evt.flowName || undefined,
            from: evt.fromMasked
          });
        } else if (evt.kind === 'status') {
          console.log('WhatsApp webhook status ingested', {
            id: evt.id,
            status: evt.status,
            recipient: evt.recipientMasked,
            hasErrors: evt.hasErrors
          });
        }
      }
    }

    // Acknowledge Meta with HTTP 200 ONLY after durable persistence has committed
    return res.status(200).type('text/plain').send('EVENT_RECEIVED');
  } catch (error) {
    // If persistence fails, return a retryable HTTP 500 error so Meta will retry delivery
    console.error('WhatsApp webhook durable persistence failed:', error.message);
    return res.status(500).type('text/plain').send('Internal Server Error');
  }
};

module.exports = {
  deduplicationCache,
  timingSafeCompare,
  maskPhoneNumber,
  parseWebhookEvents,
  verifyWebhook,
  handleWebhook
};
