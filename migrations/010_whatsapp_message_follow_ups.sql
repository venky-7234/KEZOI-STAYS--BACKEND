BEGIN;

CREATE TABLE IF NOT EXISTS whatsapp_message_follow_ups (
  id BIGSERIAL PRIMARY KEY,

  -- Reference to original inbound event
  inbound_event_id BIGINT REFERENCES whatsapp_inbound_events(id) ON DELETE CASCADE,

  -- Deterministic deduplication key: 'followup:msg:<wamid>'
  idempotency_key VARCHAR(160) NOT NULL,
  meta_message_id VARCHAR(120),

  -- Masked phone (e.g. '***3210') and SHA-256 hash. Cleartext phone is NOT stored.
  sender_phone_masked VARCHAR(20),
  sender_phone_hash VARCHAR(64) NOT NULL,

  -- Follow-up status: PENDING, CONTACTED, CONVERTED, DISMISSED
  follow_up_status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (follow_up_status IN ('PENDING', 'CONTACTED', 'CONVERTED', 'DISMISSED')),

  -- Assignment and staff notes
  assigned_to BIGINT REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,

  -- Minimal non-PII operational metadata
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

-- Unique index ensuring no duplicate follow-up records are ever created
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_message_follow_ups_idempotency_key_uidx
  ON whatsapp_message_follow_ups(idempotency_key);

-- Index for queue lookups by status
CREATE INDEX IF NOT EXISTS whatsapp_message_follow_ups_status_idx
  ON whatsapp_message_follow_ups(follow_up_status, created_at DESC);

-- Index for looking up all history for a hashed guest phone
CREATE INDEX IF NOT EXISTS whatsapp_message_follow_ups_phone_hash_idx
  ON whatsapp_message_follow_ups(sender_phone_hash);

COMMIT;
