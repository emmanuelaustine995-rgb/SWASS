ALTER TABLE aurora_admin_identity_records
  ADD COLUMN IF NOT EXISTS admin_email TEXT,
  ADD COLUMN IF NOT EXISTS admin_email_verified_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS aurora_admin_email_verification_tokens (
  id BIGSERIAL PRIMARY KEY,
  person_id TEXT NOT NULL,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS aurora_admin_email_verification_tokens_lookup
  ON aurora_admin_email_verification_tokens(token_hash, expires_at)
  WHERE used_at IS NULL;
