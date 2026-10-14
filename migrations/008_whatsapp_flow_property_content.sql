BEGIN;

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS public_description TEXT,
  ADD COLUMN IF NOT EXISTS public_location TEXT,
  ADD COLUMN IF NOT EXISTS public_amenities TEXT[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS property_marketing_photos (
  id BIGSERIAL PRIMARY KEY,
  property_id BIGINT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  image_url TEXT,
  meta_image_base64 TEXT NOT NULL,
  alt_text VARCHAR(120) NOT NULL,
  caption VARCHAR(240),
  display_order INTEGER NOT NULL DEFAULT 0,
  is_cover BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT property_marketing_photos_image_check
    CHECK (meta_image_base64 ~ '^[A-Za-z0-9+/]+={0,2}$'),
  CONSTRAINT property_marketing_photos_order_check CHECK (display_order >= 0)
);

CREATE INDEX IF NOT EXISTS property_marketing_photos_property_order_idx
  ON property_marketing_photos(property_id, is_active, display_order, id);

CREATE UNIQUE INDEX IF NOT EXISTS property_marketing_photos_one_cover_uidx
  ON property_marketing_photos(property_id) WHERE is_cover AND is_active;

COMMIT;
