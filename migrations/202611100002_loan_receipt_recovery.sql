ALTER TABLE loan_items ADD COLUMN IF NOT EXISTS national_id_hash TEXT;
CREATE INDEX IF NOT EXISTS loan_items_recovery_idx ON loan_items(national_id_hash, phone);
ALTER TABLE loan_items DROP COLUMN IF EXISTS expected_return_date;
