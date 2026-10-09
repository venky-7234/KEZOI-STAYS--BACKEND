BEGIN;

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS included_guests INTEGER NOT NULL DEFAULT 6,
  ADD COLUMN IF NOT EXISTS extra_guest_price NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_included_guests_check;
ALTER TABLE properties ADD CONSTRAINT properties_included_guests_check CHECK (included_guests >= 1);
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_extra_guest_price_check;
ALTER TABLE properties ADD CONSTRAINT properties_extra_guest_price_check CHECK (extra_guest_price >= 0);

ALTER TABLE guests
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS whatsapp_verified_at TIMESTAMPTZ;

ALTER TABLE enquiries
  ADD COLUMN IF NOT EXISTS infants INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pets INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quoted_base_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS extra_guest_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS quoted_total_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS document_type VARCHAR(30),
  ADD COLUMN IF NOT EXISTS document_path TEXT,
  ADD COLUMN IF NOT EXISTS document_original_name TEXT,
  ADD COLUMN IF NOT EXISTS document_mime_type VARCHAR(100),
  ADD COLUMN IF NOT EXISTS document_verification_status VARCHAR(20) NOT NULL DEFAULT 'PENDING';

CREATE TABLE IF NOT EXISTS contact_verifications (
  id BIGSERIAL PRIMARY KEY,
  channel VARCHAR(20) NOT NULL CHECK (channel IN ('EMAIL', 'WHATSAPP')),
  destination TEXT NOT NULL,
  code_hash VARCHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS contact_verifications_lookup_idx
  ON contact_verifications(channel, destination, created_at DESC);

CREATE INDEX IF NOT EXISTS bookings_property_dates_idx
  ON bookings(property_id, check_in, check_out);

CREATE INDEX IF NOT EXISTS property_blocks_property_dates_idx
  ON property_blocks(property_id, start_date, end_date);

COMMIT;
