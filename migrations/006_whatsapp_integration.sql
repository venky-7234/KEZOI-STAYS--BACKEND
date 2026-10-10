BEGIN;

ALTER TABLE enquiries
  ADD COLUMN IF NOT EXISTS integration_idempotency_key VARCHAR(200),
  ADD COLUMN IF NOT EXISTS integration_request_hash VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS enquiries_integration_idempotency_key_uidx
  ON enquiries(integration_idempotency_key)
  WHERE integration_idempotency_key IS NOT NULL;

COMMIT;
