const crypto = require('crypto');
const defaultPool = require('../config/database');
const { sanitizeErrorMessage } = require('./whatsappCloudApi.service');

// Strict allowlist for Meta WhatsApp Flow completion ('nfm_reply') response fields
const FLOW_ALLOWED_FIELDS = Object.freeze([
  'flow_token',
  'flow_name',
  'property_id',
  'check_in',
  'check_out',
  'adults',
  'children',
  'infants',
  'pets',
  'guest_name',
  'guest_email',
  'whatsapp_number',
  'country_code',
  'special_requests'
]);

/**
 * Computes a SHA-256 hash of a normalized phone number for privacy-safe indexing.
 * @param {string|number} phone
 * @returns {string|null}
 */
const hashPhoneNumber = (phone) => {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return null;
  return crypto.createHash('sha256').update(digits).digest('hex');
};

/**
 * Normalizes and strictly allowlists a single parsed webhook event.
 * Enforces data minimization: excludes message bodies, tokens, and unrestricted JSON.
 * @param {object} rawEvent
 * @returns {object|null}
 */
const normalizeAndAllowlistEvent = (rawEvent) => {
  if (!rawEvent || typeof rawEvent !== 'object') return null;
  const kind = rawEvent.kind;
  if (!['message', 'status'].includes(kind)) return null;

  const rawId = rawEvent.id ? String(rawEvent.id).trim() : null;
  if (!rawId) {
    // Meta protocol guarantees 'id' for all message and status events.
    // Events lacking an authentic identifier are rejected to preserve deduplication integrity.
    return null;
  }

  const maskedPhone = rawEvent.fromMasked || rawEvent.recipientMasked || null;
  const rawPhone = rawEvent.from || rawEvent.recipient_id || null;
  const phoneHash = hashPhoneNumber(rawPhone);

  let idempotencyKey;
  let eventType;
  let payload = {};
  let processingStatus = 'PENDING';

  if (kind === 'message') {
    idempotencyKey = `msg:${rawId}`;

    if (rawEvent.type === 'interactive' && rawEvent.interactiveType === 'nfm_reply') {
      eventType = 'interactive_nfm_reply';
      processingStatus = 'PENDING';

      // Parse Flow response_json if present (it arrives as a string or parsed object from Meta)
      let parsedResponse = {};
      if (typeof rawEvent.responseJson === 'string') {
        try {
          parsedResponse = JSON.parse(rawEvent.responseJson);
        } catch (_e) {
          parsedResponse = {};
        }
      } else if (rawEvent.responseJson && typeof rawEvent.responseJson === 'object') {
        parsedResponse = rawEvent.responseJson;
      }

      // Filter strictly against allowlist
      for (const field of FLOW_ALLOWED_FIELDS) {
        if (parsedResponse[field] !== undefined && parsedResponse[field] !== null) {
          if (['adults', 'children', 'infants', 'pets'].includes(field)) {
            const num = parseInt(parsedResponse[field], 10);
            payload[field] = Number.isInteger(num) && num >= 0 ? num : 0;
          } else {
            payload[field] = String(parsedResponse[field]).trim();
          }
        }
      }

      if (rawEvent.flowName) {
        payload.flow_name = String(rawEvent.flowName).trim();
      }
      if (rawEvent.flowToken && !payload.flow_token) {
        payload.flow_token = String(rawEvent.flowToken).trim();
      }
    } else if (rawEvent.type === 'text') {
      eventType = 'text';
      // In compliance with privacy guidelines, text bodies are NEVER persisted
      payload = {};
      processingStatus = 'PENDING';
    } else if (rawEvent.type === 'interactive') {
      eventType = rawEvent.interactiveType || 'interactive';
      if (rawEvent.buttonId) payload.button_id = String(rawEvent.buttonId).trim();
      if (rawEvent.listId) payload.list_id = String(rawEvent.listId).trim();
      processingStatus = 'IGNORED';
    } else if (['image', 'document', 'audio', 'video'].includes(rawEvent.type)) {
      eventType = rawEvent.type;
      // No media download URLs or media bytes are persisted
      payload = {
        mime_type: rawEvent.mimeType ? String(rawEvent.mimeType).trim() : null,
        has_media_id: Boolean(rawEvent.hasMediaId)
      };
      processingStatus = 'IGNORED';
    } else {
      eventType = rawEvent.type ? String(rawEvent.type).trim() : 'unknown';
      payload = {};
      processingStatus = 'IGNORED';
    }
  } else if (kind === 'status') {
    const statusVal = String(rawEvent.status || 'unknown').trim();
    const ts = rawEvent.timestamp ? String(rawEvent.timestamp).trim() : '';
    // Status transitions for the same message must not collapse into one key
    idempotencyKey = `status:${rawId}:${statusVal}:${ts}`;
    eventType = statusVal;
    processingStatus = 'IGNORED';

    payload = {
      status: statusVal,
      timestamp: ts || null
    };

    if (rawEvent.hasErrors) {
      if (rawEvent.errorCode) payload.error_code = rawEvent.errorCode;
      if (rawEvent.errorTitle) {
        payload.error_title = sanitizeErrorMessage(String(rawEvent.errorTitle));
      }
    }
  }

  return {
    idempotency_key: idempotencyKey,
    event_kind: kind,
    meta_message_id: rawId,
    event_type: eventType,
    sender_phone_masked: maskedPhone,
    sender_phone_hash: phoneHash,
    payload,
    processing_status: processingStatus,
    event_timestamp: rawEvent.timestamp ? String(rawEvent.timestamp).trim() : null
  };
};

/**
 * Persists an array of webhook events in PostgreSQL atomically within a transaction.
 * Deduplicates automatically via ON CONFLICT (idempotency_key) DO NOTHING.
 * @param {Array<object>} rawEvents
 * @param {object} [dbPool]
 * @returns {Promise<object>}
 */
const insertInboundEvents = async (rawEvents, dbPool = defaultPool) => {
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    return { success: true, insertedCount: 0, duplicateCount: 0, total: 0 };
  }

  const validEvents = rawEvents
    .map(normalizeAndAllowlistEvent)
    .filter(Boolean);

  if (validEvents.length === 0) {
    return { success: true, insertedCount: 0, duplicateCount: 0, total: 0 };
  }

  const client = await dbPool.connect();
  let insertedCount = 0;
  let duplicateCount = 0;

  try {
    await client.query('BEGIN');

    for (const event of validEvents) {
      const result = await client.query(
        `INSERT INTO whatsapp_inbound_events (
           idempotency_key, event_kind, meta_message_id, event_type,
           sender_phone_masked, sender_phone_hash, payload,
           processing_status, event_timestamp
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           CASE WHEN $9::text IS NOT NULL AND $9::text ~ '^[0-9]+$' THEN to_timestamp($9::double precision) ELSE NOW() END
         )
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [
          event.idempotency_key,
          event.event_kind,
          event.meta_message_id,
          event.event_type,
          event.sender_phone_masked,
          event.sender_phone_hash,
          JSON.stringify(event.payload || {}),
          event.processing_status,
          event.event_timestamp
        ]
      );

      if (result.rows && result.rows.length > 0) {
        insertedCount++;
      } else {
        duplicateCount++;
      }
    }

    await client.query('COMMIT');

    return {
      success: true,
      insertedCount,
      duplicateCount,
      total: validEvents.length
    };
  } catch (error) {
    await client.query('ROLLBACK');
    // Sanitize and mask any internal SQL error or credentials
    const cleanMessage = sanitizeErrorMessage(error.message || 'Database transaction error');
    const safeError = new Error(`Inbound event persistence failed: ${cleanMessage}`);
    safeError.isDatabaseError = true;
    throw safeError;
  } finally {
    client.release();
  }
};

/**
 * Concurrency-safe event claiming for background workers using FOR UPDATE SKIP LOCKED.
 * Reclaims:
 * 1. Eligible 'PENDING' and 'FAILED' events (retry_after <= NOW() and (locked_at IS NULL or expired))
 * 2. 'PROCESSING' events whose leases have expired (locked_at < NOW() - leaseMinutes)
 *
 * @param {string} workerId Unique worker process/container identifier
 * @param {object} [dbPool]
 * @param {number} [leaseMinutes=5]
 * @returns {Promise<object|null>}
 */
const claimNextPendingEvent = async (workerId, dbPool = defaultPool, leaseMinutes = 5) => {
  if (!workerId || !String(workerId).trim()) {
    throw new Error('workerId is required to claim an event');
  }

  const leaseMinsInt = Math.max(1, parseInt(leaseMinutes, 10) || 5);

  const client = await dbPool.connect();
  try {
    const result = await client.query(
      `UPDATE whatsapp_inbound_events
       SET processing_status = 'PROCESSING',
           locked_at = NOW(),
           locked_by = $1,
           updated_at = NOW()
       WHERE id = (
         SELECT id
         FROM whatsapp_inbound_events
         WHERE (
           -- Unclaimed or retriable event whose retry backoff has passed
           (processing_status IN ('PENDING', 'FAILED')
             AND retry_after <= NOW()
             AND (locked_at IS NULL OR locked_at < NOW() - make_interval(mins => $2::integer)))
           OR
           -- Event stuck in PROCESSING whose worker lease has expired
           (processing_status = 'PROCESSING'
             AND locked_at < NOW() - make_interval(mins => $2::integer))
         )
         ORDER BY id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [String(workerId).trim(), leaseMinsInt]
    );

    return result.rows && result.rows.length > 0 ? result.rows[0] : null;
  } finally {
    client.release();
  }
};

/**
 * Marks an event successfully processed, strictly verifying worker lease ownership.
 * If another worker reclaimed the lease, the update will affect 0 rows and return success: false.
 *
 * @param {number|string} eventId
 * @param {string} workerId
 * @param {object} [dbPool]
 * @returns {Promise<object>} { success: boolean, event?: object, reason?: string }
 */
const markEventProcessed = async (eventId, workerId, dbPool = defaultPool) => {
  if (!eventId) {
    throw new Error('eventId is required');
  }
  if (!workerId || !String(workerId).trim()) {
    throw new Error('workerId is required to verify ownership before marking event processed');
  }

  const client = await dbPool.connect();
  try {
    const result = await client.query(
      `UPDATE whatsapp_inbound_events
       SET processing_status = 'PROCESSED',
           processed_at = NOW(),
           updated_at = NOW(),
           locked_at = NULL,
           locked_by = NULL
       WHERE id = $1 AND locked_by = $2 AND processing_status = 'PROCESSING'
       RETURNING *`,
      [eventId, String(workerId).trim()]
    );

    if (result.rows && result.rows.length > 0) {
      return { success: true, event: result.rows[0] };
    }

    return { success: false, reason: 'LEASE_LOST_OR_EVENT_NOT_PROCESSING' };
  } finally {
    client.release();
  }
};

/**
 * Marks an event failed and calculates exponential backoff retry using type-safe make_interval.
 * Transitions to DEAD_LETTER when retries are exhausted.
 * Strictly verifies worker lease ownership before modifying the event.
 *
 * @param {number|string} eventId
 * @param {string} workerId
 * @param {string} errorMessage
 * @param {object} [dbPool]
 * @param {number} [maxRetries=5]
 * @returns {Promise<object>} { success: boolean, event?: object, reason?: string }
 */
const markEventFailed = async (eventId, workerId, errorMessage, dbPool = defaultPool, maxRetries = 5) => {
  if (!eventId) {
    throw new Error('eventId is required');
  }
  if (!workerId || !String(workerId).trim()) {
    throw new Error('workerId is required to verify ownership before marking event failed');
  }

  const sanitized = sanitizeErrorMessage(errorMessage || 'Unknown processing error');
  const maxRetriesInt = Math.max(1, parseInt(maxRetries, 10) || 5);

  const client = await dbPool.connect();
  try {
    const result = await client.query(
      `UPDATE whatsapp_inbound_events
       SET retry_count = retry_count + 1,
           last_error = $3,
           updated_at = NOW(),
           locked_at = NULL,
           locked_by = NULL,
           processing_status = CASE WHEN retry_count + 1 >= $4 THEN 'DEAD_LETTER' ELSE 'FAILED' END,
           retry_after = NOW() + make_interval(mins => POWER(2, LEAST(retry_count + 1, 6))::integer)
       WHERE id = $1 AND locked_by = $2 AND processing_status = 'PROCESSING'
       RETURNING *`,
      [eventId, String(workerId).trim(), sanitized, maxRetriesInt]
    );

    if (result.rows && result.rows.length > 0) {
      return { success: true, event: result.rows[0] };
    }

    return { success: false, reason: 'LEASE_LOST_OR_EVENT_NOT_PROCESSING' };
  } finally {
    client.release();
  }
};

/**
 * Marks an event as IGNORED (for non-Flow messages, status updates, or unsupported event types).
 * Strictly verifies worker lease ownership before updating.
 *
 * @param {number|string} eventId
 * @param {string} workerId
 * @param {string} [reason]
 * @param {object} [dbPool]
 * @returns {Promise<object>} { success: boolean, event?: object, reason?: string }
 */
const markEventIgnored = async (eventId, workerId, reason = 'Non-booking or unsupported event type', dbPool = defaultPool) => {
  if (!eventId) {
    throw new Error('eventId is required');
  }
  if (!workerId || !String(workerId).trim()) {
    throw new Error('workerId is required to verify ownership before marking event ignored');
  }

  const sanitized = sanitizeErrorMessage(reason || 'Ignored event');
  const client = await dbPool.connect();
  try {
    const result = await client.query(
      `UPDATE whatsapp_inbound_events
       SET processing_status = 'IGNORED',
           last_error = $3,
           updated_at = NOW(),
           locked_at = NULL,
           locked_by = NULL
       WHERE id = $1 AND locked_by = $2 AND processing_status = 'PROCESSING'
       RETURNING *`,
      [eventId, String(workerId).trim(), sanitized]
    );

    if (result.rows && result.rows.length > 0) {
      return { success: true, event: result.rows[0] };
    }

    return { success: false, reason: 'LEASE_LOST_OR_EVENT_NOT_PROCESSING' };
  } finally {
    client.release();
  }
};

module.exports = {
  FLOW_ALLOWED_FIELDS,
  hashPhoneNumber,
  normalizeAndAllowlistEvent,
  insertInboundEvents,
  claimNextPendingEvent,
  markEventProcessed,
  markEventFailed,
  markEventIgnored
};
