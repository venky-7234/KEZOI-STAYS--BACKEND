BEGIN;

CREATE TABLE IF NOT EXISTS whatsapp_inbound_events (
  id BIGSERIAL PRIMARY KEY,

  -- Deterministic deduplication key:
  -- Messages: 'msg:<wamid>'
  -- Status updates: 'status:<wamid>:<status>:<timestamp>'
  idempotency_key VARCHAR(160) NOT NULL,

  -- Event classification
  event_kind VARCHAR(20) NOT NULL CHECK (event_kind IN ('message', 'status')),
  meta_message_id VARCHAR(120),
  event_type VARCHAR(40) NOT NULL,

  -- Masked phone for non-PII operational display and hashed phone for indexing
  sender_phone_masked VARCHAR(20),
  sender_phone_hash VARCHAR(64),

  -- Data-minimized payload (strictly allowlisted, zero unrestricted chat/media content)
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Processing state machine
  processing_status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (processing_status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED', 'DEAD_LETTER')),

  -- Retry mechanics
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 5,
  retry_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Concurrency worker lease
  locked_at TIMESTAMPTZ,
  locked_by VARCHAR(64),

  -- Scrubbed diagnostic metadata
  last_error TEXT,

  -- Timestamps
  event_timestamp TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

-- Unique constraint ensuring duplicate deliveries are rejected at database level
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_inbound_events_idempotency_key_uidx
  ON whatsapp_inbound_events(idempotency_key);

-- Queue index for pending / failed retries
CREATE INDEX IF NOT EXISTS whatsapp_inbound_events_queue_idx
  ON whatsapp_inbound_events(processing_status, retry_after)
  WHERE processing_status IN ('PENDING', 'FAILED');

-- Index on meta_message_id for trace lookups
CREATE INDEX IF NOT EXISTS whatsapp_inbound_events_meta_msg_idx
  ON whatsapp_inbound_events(meta_message_id)
  WHERE meta_message_id IS NOT NULL;

COMMIT;
