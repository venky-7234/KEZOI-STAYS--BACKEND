const { validatePhoneNumber, INVALID_MOBILE_MESSAGE } = require('../utils/phoneValidator');
const { parseStay } = require('./availability.service');
const { createPendingEnquiry } = require('./metaFlowBooking.service');
const { markEventProcessed, markEventFailed } = require('./whatsappWebhookInbox.service');
const { sanitizeErrorMessage } = require('./whatsappCloudApi.service');
const defaultPool = require('../config/database');

/**
 * Checks whether an inbound webhook event is an interactive WhatsApp Flow completion event.
 * @param {object} event
 * @returns {boolean}
 */
const isFlowCompletionEvent = (event) => {
  if (!event || typeof event !== 'object') return false;
  if (event.event_kind !== 'message') return false;
  return event.event_type === 'interactive_nfm_reply' || event.event_type === 'nfm_reply';
};

/**
 * Validates required fields and types for a WhatsApp Flow booking submission.
 * Enforces authoritative validation before any database write.
 * @param {object} payload
 * @returns {{ valid: boolean, error: string|null }}
 */
const validateFlowPayload = (payload) => {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, error: 'Payload must be a valid object' };
  }

  // 1. Required fields
  const required = ['property_id', 'check_in', 'check_out', 'guest_name', 'guest_email', 'whatsapp_number'];
  const missing = required.filter(field => !payload[field] || !String(payload[field]).trim());
  if (missing.length > 0) {
    return { valid: false, error: `Missing required fields: ${missing.join(', ')}` };
  }

  // 2. Property ID must be numeric
  const propIdStr = String(payload.property_id).trim();
  if (!/^\d+$/.test(propIdStr)) {
    return { valid: false, error: 'property_id must be a valid numeric ID' };
  }

  // 3. Date format validation (YYYY-MM-DD)
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const checkInStr = String(payload.check_in).trim();
  const checkOutStr = String(payload.check_out).trim();
  if (!datePattern.test(checkInStr) || !datePattern.test(checkOutStr)) {
    return { valid: false, error: 'check_in and check_out must use YYYY-MM-DD' };
  }

  // 4. Date order validation
  const checkInDate = new Date(`${checkInStr}T00:00:00.000Z`);
  const checkOutDate = new Date(`${checkOutStr}T00:00:00.000Z`);
  if (Number.isNaN(checkInDate.getTime()) || Number.isNaN(checkOutDate.getTime()) || checkOutDate <= checkInDate) {
    return { valid: false, error: 'check_out must be after check_in' };
  }

  // 5. Guest counts validation
  const adults = payload.adults == null || payload.adults === '' ? 1 : Number(payload.adults);
  if (!Number.isInteger(adults) || adults < 1) {
    return { valid: false, error: 'adults must be at least 1 and all guest counts must be non-negative whole numbers' };
  }

  for (const field of ['children', 'infants', 'pets']) {
    const val = payload[field] == null || payload[field] === '' ? 0 : Number(payload[field]);
    if (!Number.isInteger(val) || val < 0) {
      return { valid: false, error: 'adults must be at least 1 and all guest counts must be non-negative whole numbers' };
    }
  }

  // 6. Email validation
  const email = String(payload.guest_email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { valid: false, error: 'A valid email is required' };
  }

  // 7. WhatsApp phone validation
  const phone = validatePhoneNumber(payload.whatsapp_number, payload.country_code || 'IN');
  if (!phone.valid) {
    return { valid: false, error: INVALID_MOBILE_MESSAGE };
  }

  return { valid: true, error: null };
};

/**
 * Converts a claimed WhatsApp Flow inbox event into a pending enquiry.
 *
 * Guarantees:
 * - Only processes recognized Flow completion events (interactive_nfm_reply).
 * - Validates required fields before executing database writes.
 * - Reuses existing createPendingEnquiry workflow with transactional isolation.
 * - Never trusts client-submitted prices; computes authoritative quote from properties table.
 * - Enforces deterministic idempotency via integration_idempotency_key (meta-flow:<sha256>).
 * - Checks worker lease ownership before marking the event PROCESSED or FAILED.
 * - Keeps enquiry status NEW and document_verification_status PENDING (preserves approval/KYC).
 * - Does not create bookings, payments, or outbound notifications.
 * - Redacts all customer PII from operational logging.
 *
 * @param {object|object} eventOrOptions
 * @param {string} [workerIdParam]
 * @param {object} [dbPoolParam]
 * @param {object} [optionsParam]
 * @returns {Promise<object>} Result summary
 */
const convertFlowInboxEventToEnquiry = async (
  eventOrOptions,
  workerIdParam,
  dbPoolParam,
  optionsParam = {}
) => {
  let event, workerId, dbPool, maxRetries;
  if (eventOrOptions && eventOrOptions.event) {
    event = eventOrOptions.event;
    workerId = eventOrOptions.workerId;
    dbPool = eventOrOptions.dbPool || defaultPool;
    maxRetries = eventOrOptions.maxRetries || 5;
  } else {
    event = eventOrOptions;
    workerId = workerIdParam;
    dbPool = dbPoolParam || defaultPool;
    maxRetries = optionsParam.maxRetries || 5;
  }

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

  // 2. Process only explicitly recognized WhatsApp Flow completion events
  if (!isFlowCompletionEvent(event)) {
    return {
      success: false,
      reason: 'NOT_A_FLOW_COMPLETION_EVENT',
      error: 'Event is not an interactive WhatsApp Flow completion (nfm_reply) message'
    };
  }

  // Normalize database pool / mock interface
  const normalizedPool = typeof dbPool.connect === 'function'
    ? dbPool
    : { connect: async () => dbPool, query: dbPool.query.bind(dbPool) };

  // 3. Pre-write validation of required payload fields and types
  const payload = event.payload || {};
  const validation = validateFlowPayload(payload);
  if (!validation.valid) {
    const failRes = await markEventFailed(
      event.id,
      normalizedWorkerId,
      validation.error,
      normalizedPool,
      maxRetries
    );
    return {
      success: false,
      status: 400,
      error: validation.error,
      failureResult: failRes
    };
  }

  // 4. Extract deterministic Flow token for idempotency key derivation
  const flowToken = payload.flow_token
    ? String(payload.flow_token).trim()
    : (event.meta_message_id ? String(event.meta_message_id).trim() : null);

  if (!flowToken) {
    const failRes = await markEventFailed(
      event.id,
      normalizedWorkerId,
      'A Flow submission token is required',
      normalizedPool,
      maxRetries
    );
    return {
      success: false,
      status: 400,
      error: 'A Flow submission token is required',
      failureResult: failRes
    };
  }

  const flowData = {
    property_id: String(payload.property_id).trim(),
    check_in: String(payload.check_in).trim(),
    check_out: String(payload.check_out).trim(),
    adults: payload.adults == null || payload.adults === '' ? 1 : Number(payload.adults),
    children: payload.children == null || payload.children === '' ? 0 : Number(payload.children),
    infants: payload.infants == null || payload.infants === '' ? 0 : Number(payload.infants),
    pets: payload.pets == null || payload.pets === '' ? 0 : Number(payload.pets),
    guest_name: String(payload.guest_name).trim(),
    guest_email: String(payload.guest_email).trim().toLowerCase(),
    whatsapp_number: String(payload.whatsapp_number).trim(),
    country_code: payload.country_code ? String(payload.country_code).trim() : 'IN',
    special_requests: payload.special_requests ? String(payload.special_requests).trim() : '',
    flow_token: flowToken
  };

  // 5. Execute authoritative enquiry creation inside an isolated connection / transaction
  let client;
  try {
    client = await normalizedPool.connect();
    const createResult = await createPendingEnquiry(client, flowData);

    if (createResult.error) {
      const failRes = await markEventFailed(
        event.id,
        normalizedWorkerId,
        createResult.error,
        normalizedPool,
        maxRetries
      );
      return {
        success: false,
        status: createResult.status || 400,
        error: createResult.error,
        failureResult: failRes
      };
    }

    // 6. Check worker lease ownership when marking event processed
    const processRes = await markEventProcessed(
      event.id,
      normalizedWorkerId,
      normalizedPool
    );

    if (!processRes.success) {
      return {
        success: false,
        reason: processRes.reason || 'LEASE_LOST_OR_EVENT_NOT_PROCESSING',
        enquiry: createResult.enquiry,
        replayed: createResult.replayed
      };
    }

    return {
      success: true,
      enquiry: createResult.enquiry,
      replayed: createResult.replayed,
      event: processRes.event
    };
  } catch (error) {
    const cleanError = sanitizeErrorMessage(error.message || 'Error creating enquiry from Flow event');
    const failRes = await markEventFailed(
      event.id,
      normalizedWorkerId,
      cleanError,
      normalizedPool,
      maxRetries
    );
    return {
      success: false,
      status: 500,
      error: cleanError,
      failureResult: failRes
    };
  } finally {
    if (client && typeof client.release === 'function') {
      try {
        client.release();
      } catch (_e) {}
    }
  }
};

module.exports = {
  isFlowCompletionEvent,
  validateFlowPayload,
  convertFlowInboxEventToEnquiry
};
