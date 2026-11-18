-- Referral programme and separate cashback balance.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS referral_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS tenants_referral_code_unique ON tenants(referral_code) WHERE referral_code IS NOT NULL;
ALTER TABLE signup_otp_requests ADD COLUMN IF NOT EXISTS referral_code TEXT;
CREATE TABLE IF NOT EXISTS tenant_referrals (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 referrer_tenant_id UUID NOT NULL REFERENCES tenants(id),
 referred_tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id),
 referral_code TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(referrer_tenant_id <> referred_tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_tenant_referrals_referrer ON tenant_referrals(referrer_tenant_id,created_at DESC);
CREATE TABLE IF NOT EXISTS referral_rewards (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 referrer_tenant_id UUID NOT NULL REFERENCES tenants(id),
 referred_tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id),
 payment_id UUID NOT NULL UNIQUE REFERENCES payments(id),
 amount_kes BIGINT NOT NULL CHECK(amount_kes > 0),
 status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','withdrawal_requested','paid')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_referral_rewards_referrer ON referral_rewards(referrer_tenant_id,created_at DESC);
CREATE TABLE IF NOT EXISTS referral_withdrawal_requests (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id UUID NOT NULL REFERENCES tenants(id),
 amount_kes BIGINT NOT NULL CHECK(amount_kes > 0),
 payout_phone TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','paid','rejected')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_referral_withdrawals_tenant ON referral_withdrawal_requests(tenant_id,created_at DESC);
