const defaultPool = require('../config/database');
const { markEventProcessed, markEventFailed } = require('./whatsappWebhookInbox.service');
const { sanitizeErrorMessage } = require('./whatsappCloudApi.service');

/**
 * Checks whether an inbound webhook event is an ordinary WhatsApp text message.
 * Strictly excludes Flow completion events ('interactive_nfm_reply'), status events, and media.
 *
 * @param {object} event
 * @returns {boolean}
 */
const isOrdinaryTextMessageEvent = (event) => {
  if (!event || typeof event !== 'object') return false;
  if (event.event_kind !== 'message') return false;
  return event.event_type === 'text';
};

/**
 * Processes an ordinary inbound WhatsApp message into a durable follow-up record for staff.
 *
 * Guarantees:
 * - Does NOT create a booking enquiry, application, or fabricated guest record.
 * - Does NOT persist cleartext message bodies, full webhook payloads, or unmasked phone numbers.
 * - Uses existing masked phone and hashed phone fields for indexing and staff contact context.
 * - Enforces deterministic idempotency: duplicate deliveries cannot create duplicate follow-up records.
 * - Strictly verifies worker lease ownership before marking the event PROCESSED.
 * - Handles transient database errors safely with bounded exponential backoff.
 * - Does NOT trigger automated replies or 'BOOKING_REQUEST_RECEIVED' notifications.
 * - Redacts all sensitive information from operational logs and error messages.
 *
 * @param {object} params
 * @param {object} params.event The claimed whatsapp_inbound_events row
 * @param {string} params.workerId The ID of the claiming background worker
 * @param {object} [params.dbPool] Database pool or mock client
 * @param {number} [params.maxRetries=5] Maximum attempts before dead-lettering
 * @returns {Promise<object>} Processing outcome
 */
const processOrdinaryMessageFollowUp = async ({
  event,
  workerId,
  dbPool = defaultPool,
  maxRetries = 5
}) => {
  if (!event || typeof event !== 'object' || !event.id) {
    throw new Error('A valid inbox event with an id is required');
  }
  if (!workerId || !String(workerId).trim()) {
    throw new Error('workerId is required to process inbox event');
  }

  const normalizedWorkerId = String(workerId).trim();

  // 1. Worker lease pre-check if lock metadata is present on event
  if (event.locked_by && event.locked_by !== normalizedWorkerId) {
    return {
      success: false,
      reason: 'WORKER_DOES_NOT_OWN_LEASE',
      error: 'Worker does not own the lease for this event'
    };
  }

  // 2. Reject non-text events (Flow events belong to convertFlowInboxEventToEnquiry)
  if (!isOrdinaryTextMessageEvent(event)) {
    return {
      success: false,
      reason: 'NOT_AN_ORDINARY_TEXT_EVENT',
      error: `Event type '${event.event_type || 'unknown'}' is not an ordinary text message`
    };
  }

  // Normalize database pool / mock interface
  const normalizedPool = typeof dbPool.connect === 'function'
    ? dbPool
    : { connect: async () => dbPool, query: dbPool.query.bind(dbPool) };

  const client = await normalizedPool.connect();

  try {
    // 3. Deterministic idempotency key to prevent duplicate follow-up records
    const idempotencyKey = `followup:${event.idempotency_key || `msg:${event.meta_message_id || event.id}`}`;
    const phoneHash = event.sender_phone_hash || 'unknown_hash';
    const phoneMasked = event.sender_phone_masked || null;

    // 4. Insert or update follow-up record idempotently
    const insertSql = `
      INSERT INTO whatsapp_message_follow_ups (
        inbound_event_id,
        idempotency_key,
        meta_message_id,
        sender_phone_masked,
        sender_phone_hash,
        follow_up_status,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, 'PENDING', $6::jsonb)
      ON CONFLICT (idempotency_key) DO UPDATE
        SET updated_at = NOW()
      RETURNING *,
        (xmax = 0) AS is_new_insert;
    `;

    const metadata = {
      source: 'whatsapp_direct_message',
      event_timestamp: event.event_timestamp || null
    };

    const followUpResult = await client.query(insertSql, [
      event.id,
      idempotencyKey,
      event.meta_message_id || null,
      phoneMasked,
      phoneHash,
      JSON.stringify(metadata)
    ]);

    const followUp = followUpResult.rows && followUpResult.rows.length > 0
      ? followUpResult.rows[0]
      : null;

    const isReplay = followUp && followUp.is_new_insert === false;

    // 5. Complete inbox event processing lease
    const markResult = await markEventProcessed(
      event.id,
      normalizedWorkerId,
      normalizedPool
    );

    if (!markResult.success) {
      return {
        success: false,
        reason: markResult.reason || 'WORKER_LEASE_LOST_DURING_UPDATE',
        error: 'Worker lost lease while marking inbox event processed'
      };
    }

    return {
      success: true,
      followUp,
      followUpId: followUp?.id,
      replayed: Boolean(isReplay)
    };
  } catch (error) {
    const safeError = sanitizeErrorMessage(error.message || 'Error recording message follow-up');

    // Record failure with bounded exponential backoff
    await markEventFailed(
      event.id,
      normalizedWorkerId,
      safeError,
      normalizedPool,
      maxRetries
    );

    return {
      success: false,
      error: safeError
    };
  } finally {
    if (typeof client.release === 'function') {
      client.release();
    }
  }
};

/**
 * Lists WhatsApp message follow-ups for staff review and action.
 *
 * @param {object} [filters]
 * @param {string} [filters.status] 'PENDING', 'CONTACTED', 'CONVERTED', 'DISMISSED'
 * @param {number} [filters.limit=50]
 * @param {number} [filters.offset=0]
 * @param {object} [dbPool]
 * @returns {Promise<Array<object>>}
 */
const listMessageFollowUps = async (filters = {}, dbPool = defaultPool) => {
  const conditions = [];
  const params = [];

  if (filters.status && String(filters.status).trim()) {
    params.push(String(filters.status).trim().toUpperCase());
    conditions.push(`follow_up_status = $${params.length}`);
  }

  const limit = Math.min(100, Math.max(1, parseInt(filters.limit, 10) || 50));
  const offset = Math.max(0, parseInt(filters.offset, 10) || 0);

  params.push(limit);
  const limitPlaceholder = `$${params.length}`;
  params.push(offset);
  const offsetPlaceholder = `$${params.length}`;

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT
      id,
      inbound_event_id,
      meta_message_id,
      sender_phone_masked,
      follow_up_status,
      assigned_to,
      notes,
      metadata,
      created_at,
      updated_at,
      resolved_at
    FROM whatsapp_message_follow_ups
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder};
  `;

  const result = await dbPool.query(sql, params);
  return result.rows || [];
};

/**
 * Updates a follow-up record status or assigns it to staff.
 *
 * @param {number|string} id
 * @param {object} updates
 * @param {string} [updates.follow_up_status]
 * @param {number} [updates.assigned_to]
 * @param {string} [updates.notes]
 * @param {object} [dbPool]
 * @returns {Promise<object|null>}
 */
const updateMessageFollowUp = async (id, updates = {}, dbPool = defaultPool) => {
  if (!id) throw new Error('Follow-up ID is required');

  const validStatuses = ['PENDING', 'CONTACTED', 'CONVERTED', 'DISMISSED'];
  let statusVal = null;
  if (updates.follow_up_status) {
    statusVal = String(updates.follow_up_status).trim().toUpperCase();
    if (!validStatuses.includes(statusVal)) {
      throw new Error(`Invalid follow_up_status. Must be one of: ${validStatuses.join(', ')}`);
    }
  }

  const sql = `
    UPDATE whatsapp_message_follow_ups
    SET
      follow_up_status = COALESCE($2, follow_up_status),
      assigned_to = COALESCE($3, assigned_to),
      notes = COALESCE($4, notes),
      resolved_at = CASE
        WHEN $2 IN ('CONVERTED', 'DISMISSED') THEN NOW()
        WHEN $2 IN ('PENDING', 'CONTACTED') THEN NULL
        ELSE resolved_at
      END,
      updated_at = NOW()
    WHERE id = $1
    RETURNING *;
  `;

  const result = await dbPool.query(sql, [
    id,
    statusVal,
    updates.assigned_to || null,
    updates.notes || null
  ]);

  return result.rows && result.rows.length > 0 ? result.rows[0] : null;
};

module.exports = {
  isOrdinaryTextMessageEvent,
  processOrdinaryMessageFollowUp,
  listMessageFollowUps,
  updateMessageFollowUp
};
