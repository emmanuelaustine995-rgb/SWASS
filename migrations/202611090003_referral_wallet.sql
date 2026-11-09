-- Referral commissions and withdrawal processing.
CREATE TABLE IF NOT EXISTS referral_commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_tenant_id UUID NOT NULL REFERENCES tenants(id),
  referred_tenant_id UUID NOT NULL REFERENCES tenants(id),
  payment_id UUID NOT NULL UNIQUE REFERENCES payments(id),
  commission_type TEXT NOT NULL CHECK (commission_type IN ('vendor_activation')),
  amount_kes BIGINT NOT NULL CHECK (amount_kes > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (referrer_tenant_id <> referred_tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_referral_commissions_referrer ON referral_commissions(referrer_tenant_id,created_at DESC);
CREATE TABLE IF NOT EXISTS platform_payment_splits (
  id BIGSERIAL PRIMARY KEY,
  payment_id UUID NOT NULL UNIQUE REFERENCES payments(id),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  payment_purpose TEXT NOT NULL CHECK (payment_purpose IN ('subscription','vendor_fee')),
  gross_amount_kes BIGINT NOT NULL CHECK (gross_amount_kes > 0),
  company_amount_kes BIGINT NOT NULL CHECK (company_amount_kes >= 0),
  referral_amount_kes BIGINT NOT NULL CHECK (referral_amount_kes >= 0),
  referrer_tenant_id UUID REFERENCES tenants(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (company_amount_kes + referral_amount_kes = gross_amount_kes)
);
CREATE INDEX IF NOT EXISTS idx_platform_payment_splits_created ON platform_payment_splits(created_at DESC);
ALTER TABLE referral_withdrawal_requests
  ADD COLUMN IF NOT EXISTS payout_reference TEXT,
  ADD COLUMN IF NOT EXISTS admin_note TEXT,
  ADD COLUMN IF NOT EXISTS processed_by UUID REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_referral_withdrawals_status ON referral_withdrawal_requests(status,created_at ASC);
