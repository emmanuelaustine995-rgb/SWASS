ALTER TABLE aurora_admin_identity_records
  ADD COLUMN IF NOT EXISTS admin_email TEXT,
  ADD COLUMN IF NOT EXISTS admin_email_verified_at TIMESTAMPTZ;

-- Preserve any administrator registrations made before admin email isolation.
-- Their verified shop-account email remains the admin contact until re-registered.
UPDATE aurora_admin_identity_records r
   SET admin_email = u.email,
       admin_email_verified_at = u.email_verified_at
  FROM users u
 WHERE u.id = r.user_id
   AND r.admin_email IS NULL;

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
