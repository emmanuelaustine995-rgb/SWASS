-- AURORA administrator registration. National IDs are stored only as keyed hashes.
CREATE TABLE IF NOT EXISTS aurora_admin_registration_otps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  national_id_hash TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aurora_admin_reg_otp_lookup
  ON aurora_admin_registration_otps(lower(email), phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aurora_admin_reg_otp_rate
  ON aurora_admin_registration_otps(phone, created_at DESC);

CREATE TABLE IF NOT EXISTS aurora_admin_identity_records (
  id BIGSERIAL PRIMARY KEY,
  person_id TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  national_id_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
