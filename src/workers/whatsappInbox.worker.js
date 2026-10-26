const crypto = require('crypto');
const defaultPool = require('../config/database');
const {
  claimNextPendingEvent,
  markEventIgnored
} = require('../services/whatsappWebhookInbox.service');
const {
  isFlowCompletionEvent,
  convertFlowInboxEventToEnquiry
} = require('../services/whatsappFlowEnquiry.service');
const {
  isOrdinaryTextMessageEvent,
  processOrdinaryMessageFollowUp
} = require('../services/whatsappMessageFollowUp.service');
const { sanitizeErrorMessage } = require('../services/whatsappCloudApi.service');

/**
 * Checks whether the WhatsApp inbox worker is enabled via environment variables.
 * Defaults to false (disabled) unless explicitly configured.
 * @returns {boolean}
 */
const isWorkerEnabled = () => {
  const flag = String(process.env.ENABLE_WHATSAPP_INBOX_WORKER || '').trim().toLowerCase();
  return flag === 'true' || flag === '1' || flag === 'yes';
};

/**
 * Generates a unique, non-PII worker identifier for this process instance.
 * @param {string} [prefix='whatsapp-inbox-worker']
 * @returns {string}
 */
const generateWorkerId = (prefix = 'whatsapp-inbox-worker') => {
  const base = (process.env.WORKER_ID && String(process.env.WORKER_ID).trim()) || prefix;
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const candidate = `${base}-${process.pid}-${randomSuffix}`;
  return candidate.length <= 64 ? candidate : candidate.slice(0, 64);
};

/**
 * Factory for creating an isolated WhatsApp inbox background worker.
 * Allows multiple instances in tests with custom mock pools and configurations.
 *
 * @param {object} [options]
 * @returns {object} Worker instance
 */
const createWorker = (options = {}) => {
  const workerId = options.workerId || generateWorkerId();
  const dbPool = options.dbPool || defaultPool;
  const pollIntervalMs = Math.max(100, parseInt(options.pollIntervalMs || process.env.WORKER_POLL_INTERVAL_MS, 10) || 3000);
  const errorBackoffMs = Math.max(500, parseInt(options.errorBackoffMs || process.env.WORKER_ERROR_BACKOFF_MS, 10) || 5000);
  const leaseMinutes = Math.max(1, parseInt(options.leaseMinutes || process.env.WORKER_LEASE_MINUTES, 10) || 5);
  const maxRetries = Math.max(1, parseInt(options.maxRetries || process.env.WORKER_MAX_RETRIES, 10) || 5);
  const forceEnable = Boolean(options.forceEnable);

  let isRunning = false;
  let isProcessing = false;
  let pollTimer = null;
  let currentTickPromise = null;

  /**
   * Processes a single claimed event or returns if queue is empty.
   * Transactionally safe, enforces lease ownership, and never exposes PII.
   * @returns {Promise<object>}
   */
  const tick = async () => {
    try {
      // 1. Claim next eligible pending, retriable failed, or expired processing lease
      const event = await claimNextPendingEvent(workerId, dbPool, leaseMinutes);

      if (!event) {
        return { processed: false, reason: 'NO_ELIGIBLE_EVENTS' };
      }

      // 2. Branch A: Interactive WhatsApp Flow completion event
      if (isFlowCompletionEvent(event)) {
        const result = await convertFlowInboxEventToEnquiry({
          event,
          workerId,
          dbPool,
          maxRetries
        });

        // Safe operational logging (zero PII, no guest names, emails, phones, or tokens)
        if (result.success) {
          console.log('WhatsApp inbox worker: Flow enquiry processed', {
            workerId,
            eventId: event.id,
            enquiryId: result.enquiry?.id,
            replayed: Boolean(result.replayed)
          });
        } else {
          console.warn('WhatsApp inbox worker: Flow enquiry failed or lease lost', {
            workerId,
            eventId: event.id,
            reason: result.reason || undefined,
            error: result.error ? sanitizeErrorMessage(result.error) : undefined
          });
        }

        return {
          processed: true,
          eventId: event.id,
          eventKind: 'flow',
          result
        };
      }

      // 2. Branch B: Ordinary inbound text message event
      if (isOrdinaryTextMessageEvent(event)) {
        const result = await processOrdinaryMessageFollowUp({
          event,
          workerId,
          dbPool,
          maxRetries
        });

        if (result.success) {
          console.log('WhatsApp inbox worker: Ordinary message follow-up recorded', {
            workerId,
            eventId: event.id,
            followUpId: result.followUpId,
            replayed: Boolean(result.replayed)
          });
        } else {
          console.warn('WhatsApp inbox worker: Ordinary message follow-up failed or lease lost', {
            workerId,
            eventId: event.id,
            reason: result.reason || undefined,
            error: result.error ? sanitizeErrorMessage(result.error) : undefined
          });
        }

        return {
          processed: true,
          eventId: event.id,
          eventKind: 'follow-up',
          result
        };
      }

      // 3. Branch C: Non-Flow / unsupported event (status, media, etc.): mark IGNORED
      const ignoreResult = await markEventIgnored(
        event.id,
        workerId,
        `Non-booking event type '${event.event_type || 'unknown'}' ignored by worker`,
        dbPool
      );

      console.log('WhatsApp inbox worker: Non-Flow event ignored', {
        workerId,
        eventId: event.id,
        eventType: event.event_type
      });

      return {
        processed: true,
        eventId: event.id,
        eventKind: 'non-flow',
        result: ignoreResult
      };
    } catch (error) {
      const safeMessage = sanitizeErrorMessage(error.message || 'Worker processing error');
      console.error('WhatsApp inbox worker tick error:', safeMessage);
      return {
        processed: false,
        error: safeMessage
      };
    }
  };

  /**
   * Internal scheduler for continuous background execution.
   * Prevents overlapping ticks and CPU spinning.
   * @param {number} delayMs
   */
  const scheduleNext = (delayMs) => {
    if (!isRunning) return;
    if (pollTimer) clearTimeout(pollTimer);

    pollTimer = setTimeout(async () => {
      if (!isRunning) return;
      isProcessing = true;
      try {
        currentTickPromise = tick();
        const outcome = await currentTickPromise;

        if (!isRunning) return;

        // Drain queue quickly if an event was processed successfully; otherwise poll delay
        if (outcome.processed && outcome.result?.success) {
          scheduleNext(50);
        } else if (outcome.error) {
          scheduleNext(errorBackoffMs);
        } else {
          scheduleNext(pollIntervalMs);
        }
      } catch (err) {
        if (!isRunning) return;
        scheduleNext(errorBackoffMs);
      } finally {
        isProcessing = false;
        currentTickPromise = null;
      }
    }, delayMs);

    // In testing environments, do not hold process alive solely for worker timer
    if (pollTimer && typeof pollTimer.unref === 'function') {
      pollTimer.unref();
    }
  };

  /**
   * Starts the background processing loop.
   * Safe against multiple calls (idempotent start).
   * @returns {object} { started: boolean, reason?: string, workerId?: string }
   */
  const start = () => {
    if (!forceEnable && !isWorkerEnabled()) {
      console.log('WhatsApp inbox worker is disabled by configuration (ENABLE_WHATSAPP_INBOX_WORKER!=true)');
      return { started: false, reason: 'DISABLED_BY_CONFIGURATION' };
    }

    if (isRunning) {
      return { started: false, reason: 'ALREADY_RUNNING', workerId };
    }

    isRunning = true;
    console.log(`WhatsApp inbox worker started [id: ${workerId}, poll: ${pollIntervalMs}ms, lease: ${leaseMinutes}m]`);
    scheduleNext(0);

    return { started: true, workerId };
  };

  /**
   * Stops the worker gracefully.
   * Awaits any in-flight database transaction before resolving.
   * @param {number} [timeoutMs=10000]
   * @returns {Promise<object>}
   */
  const stop = async (timeoutMs = 10000) => {
    if (!isRunning && !isProcessing) {
      return { stopped: true, alreadyStopped: true };
    }

    isRunning = false;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }

    if (isProcessing && currentTickPromise) {
      const timeoutPromise = new Promise((resolve) => setTimeout(resolve, timeoutMs));
      await Promise.race([currentTickPromise, timeoutPromise]);
    }

    console.log(`WhatsApp inbox worker stopped [id: ${workerId}]`);
    return { stopped: true, workerId };
  };

  return {
    workerId,
    tick,
    start,
    stop,
    get isRunning() {
      return isRunning;
    },
    get isProcessing() {
      return isProcessing;
    },
    getConfiguration: () => ({
      workerId,
      enabled: forceEnable || isWorkerEnabled(),
      pollIntervalMs,
      errorBackoffMs,
      leaseMinutes,
      maxRetries
    })
  };
};

// Default singleton instance
const defaultWorker = createWorker();

/**
 * Handles graceful process shutdown on SIGINT/SIGTERM.
 * @param {object} [workerInstance]
 */
const setupProcessSignalHandlers = (workerInstance = defaultWorker) => {
  const shutdown = async (signal) => {
    console.log(`Received ${signal}, gracefully stopping WhatsApp inbox worker...`);
    try {
      await workerInstance.stop(5000);
      if (typeof defaultPool.end === 'function') {
        await defaultPool.end();
      }
      process.exit(0);
    } catch (err) {
      console.error('Error during worker shutdown:', err.message);
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
};

// CLI entrypoint execution (when run directly via `node src/workers/whatsappInbox.worker.js`)
if (require.main === module) {
  require('dotenv').config({ path: process.env.ENV_FILE || '.env' });
  const worker = createWorker({ forceEnable: true });
  setupProcessSignalHandlers(worker);
  worker.start();
}

module.exports = {
  isWorkerEnabled,
  generateWorkerId,
  createWorker,
  startWorker: () => defaultWorker.start(),
  stopWorker: () => defaultWorker.stop(),
  processNextEvent: () => defaultWorker.tick(),
  getWorkerStatus: () => ({
    isRunning: defaultWorker.isRunning,
    isProcessing: defaultWorker.isProcessing,
    configuration: defaultWorker.getConfiguration()
  }),
  setupProcessSignalHandlers
};
