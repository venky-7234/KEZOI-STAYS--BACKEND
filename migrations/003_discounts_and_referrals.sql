BEGIN;

ALTER TABLE guests
  ADD COLUMN IF NOT EXISTS referral_name VARCHAR(150),
  ADD COLUMN IF NOT EXISTS referral_mobile VARCHAR(30);

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS discount_reason TEXT,
  ADD COLUMN IF NOT EXISTS discount_updated_by BIGINT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS discount_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS guests_referral_mobile_idx
  ON guests(referral_mobile)
  WHERE referral_mobile IS NOT NULL;

COMMIT;
