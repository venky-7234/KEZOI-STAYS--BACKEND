BEGIN;

ALTER TABLE enquiries
  DROP CONSTRAINT IF EXISTS enquiries_source_check;

ALTER TABLE enquiries
  ADD CONSTRAINT enquiries_source_check
  CHECK (source IN (
    'WEBSITE',
    'TG-0001',
    'WHATSAPP',
    'REFERRAL',
    'INSTAGRAM',
    'PHONE',
    'AIRBNB',
    'WALK_IN',
    'OTHER'
  ));

COMMIT;
