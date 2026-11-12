ALTER TABLE customer_accounts ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE customer_signup_otp_requests ADD COLUMN IF NOT EXISTS referral_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS customer_accounts_referral_code_unique ON customer_accounts(referral_code) WHERE referral_code IS NOT NULL;
CREATE TABLE IF NOT EXISTS customer_referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_customer_id UUID NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  referred_customer_id UUID NOT NULL UNIQUE REFERENCES customer_accounts(id) ON DELETE CASCADE,
  referral_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (referrer_customer_id <> referred_customer_id)
);
CREATE INDEX IF NOT EXISTS customer_referrals_referrer_created ON customer_referrals(referrer_customer_id,created_at DESC);
