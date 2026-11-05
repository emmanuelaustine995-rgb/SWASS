-- 010: secure phone OTP verification for new business registrations
CREATE TABLE IF NOT EXISTS signup_otp_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT NOT NULL,
  business_name TEXT NOT NULL,
  store_name TEXT NOT NULL,
  store_location TEXT,
  full_name TEXT NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  ip_address INET,
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_signup_otp_phone_created
  ON signup_otp_requests(phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signup_otp_ip_created
  ON signup_otp_requests(ip_address, created_at DESC);
