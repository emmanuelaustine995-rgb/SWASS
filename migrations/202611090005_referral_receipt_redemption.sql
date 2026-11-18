-- Convert referral rewards into receipt-wallet credits only, and set the per-receipt fee to KSh 4.
CREATE TABLE IF NOT EXISTS referral_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  amount_kes BIGINT NOT NULL CHECK (amount_kes >= 4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_referral_redemptions_tenant
  ON referral_redemptions(tenant_id, created_at DESC);

ALTER TABLE wallet_transactions
  DROP CONSTRAINT IF EXISTS wallet_transactions_reason_check;
ALTER TABLE wallet_transactions
  ADD CONSTRAINT wallet_transactions_reason_check
  CHECK (reason IN ('topup','receipt_fee','refund','referral_redemption'));
