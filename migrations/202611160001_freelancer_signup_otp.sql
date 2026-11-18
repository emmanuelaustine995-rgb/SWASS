-- Permit the same verified person to hold separate owner/admin and freelancer login roles.
-- Uniqueness remains enforced within each account role; records and credentials are not overwritten.
DROP INDEX IF EXISTS users_active_phone_unique;
CREATE UNIQUE INDEX IF NOT EXISTS users_active_phone_role_unique
  ON users (phone, role)
  WHERE is_active=true;

DROP INDEX IF EXISTS users_active_national_id_number_unique;
CREATE UNIQUE INDEX IF NOT EXISTS users_active_national_id_role_unique
  ON users (national_id_number, role)
  WHERE is_active=true
    AND national_id_number IS NOT NULL
    AND national_id_number <> '';

-- Pending freelancer registrations are stored only until the phone OTP is verified.
CREATE TABLE IF NOT EXISTS freelancer_signup_otp_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT NOT NULL,
  owner_phone TEXT NOT NULL,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  national_id_number TEXT NOT NULL,
  national_id_photo_data TEXT NOT NULL,
  profile_photo_data TEXT NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  store_id UUID NOT NULL REFERENCES stores(id),
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_freelancer_signup_otp_phone_created
  ON freelancer_signup_otp_requests(phone, created_at DESC);
