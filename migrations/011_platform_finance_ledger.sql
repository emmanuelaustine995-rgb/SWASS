-- 011: immutable platform revenue ledger. Shop sale proceeds are deliberately excluded.
CREATE TABLE IF NOT EXISTS platform_financial_ledger (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID REFERENCES tenants(id),
  payment_id UUID REFERENCES payments(id),
  receipt_id UUID REFERENCES receipts(id),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('subscription_revenue','receipt_fee_revenue')),
  amount_kes BIGINT NOT NULL CHECK (amount_kes > 0),
  external_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (entry_type = 'subscription_revenue' AND payment_id IS NOT NULL AND receipt_id IS NULL)
    OR
    (entry_type = 'receipt_fee_revenue' AND receipt_id IS NOT NULL AND payment_id IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_ledger_subscription_payment
  ON platform_financial_ledger(payment_id) WHERE entry_type = 'subscription_revenue';
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_ledger_receipt_fee
  ON platform_financial_ledger(receipt_id) WHERE entry_type = 'receipt_fee_revenue';
CREATE INDEX IF NOT EXISTS idx_platform_ledger_created
  ON platform_financial_ledger(created_at DESC);
