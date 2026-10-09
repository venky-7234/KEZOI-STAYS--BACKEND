BEGIN;

CREATE TABLE IF NOT EXISTS mobile_discount_offers (
  id BIGSERIAL PRIMARY KEY,
  mobile_number VARCHAR(30) NOT NULL UNIQUE,
  discount_percentage NUMERIC(5,2) NOT NULL CHECK (discount_percentage > 0 AND discount_percentage <= 100),
  reason TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_until TIMESTAMPTZ,
  created_by BIGINT NOT NULL REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);

ALTER TABLE enquiries
  ADD COLUMN IF NOT EXISTS original_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS discount_percentage NUMERIC(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mobile_discount_offer_id BIGINT REFERENCES mobile_discount_offers(id);

CREATE INDEX IF NOT EXISTS mobile_discount_offers_active_idx
  ON mobile_discount_offers(mobile_number, status, valid_until);

COMMIT;
