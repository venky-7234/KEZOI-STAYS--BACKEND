BEGIN;

ALTER TABLE enquiries
  ADD COLUMN IF NOT EXISTS document_reviewed_by BIGINT,
  ADD COLUMN IF NOT EXISTS document_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS document_rejection_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'enquiries_document_reviewed_by_fkey'
       AND conrelid = 'enquiries'::regclass
  ) THEN
    ALTER TABLE enquiries
      ADD CONSTRAINT enquiries_document_reviewed_by_fkey
      FOREIGN KEY (document_reviewed_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMIT;
