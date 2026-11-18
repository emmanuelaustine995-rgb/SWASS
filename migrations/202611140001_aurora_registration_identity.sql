-- AURORA registration identity fields. Store ID numbers as keyed hashes and
-- keep uploaded owner identity images separate from the general user profile.
ALTER TABLE signup_otp_requests
  ADD COLUMN IF NOT EXISTS national_id_hash TEXT,
  ADD COLUMN IF NOT EXISTS id_photo_data TEXT,
  ADD COLUMN IF NOT EXISTS passport_photo_data TEXT;

ALTER TABLE customer_accounts
  ADD COLUMN IF NOT EXISTS national_id_hash TEXT;

ALTER TABLE customer_signup_otp_requests
  ADD COLUMN IF NOT EXISTS national_id_hash TEXT;

CREATE TABLE IF NOT EXISTS aurora_owner_identity_records (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  national_id_hash TEXT NOT NULL UNIQUE,
  id_photo_data TEXT NOT NULL,
  passport_photo_data TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_accounts_national_id_hash_unique
  ON customer_accounts(national_id_hash)
  WHERE national_id_hash IS NOT NULL;
