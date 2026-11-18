-- 008: preserve product cost at sale time and record business expenses
ALTER TABLE receipt_items
  ADD COLUMN IF NOT EXISTS unit_cost_kes BIGINT NOT NULL DEFAULT 0
  CHECK (unit_cost_kes >= 0);

CREATE TABLE IF NOT EXISTS business_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  store_id UUID NOT NULL REFERENCES stores(id),
  recorded_by UUID NOT NULL REFERENCES users(id),
  amount_kes BIGINT NOT NULL CHECK (amount_kes > 0),
  category TEXT NOT NULL,
  note TEXT,
  spent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (length(trim(category)) BETWEEN 1 AND 80),
  CHECK (note IS NULL OR length(note) <= 240)
);
CREATE INDEX IF NOT EXISTS idx_business_expenses_tenant_store_date
  ON business_expenses (tenant_id, store_id, spent_at DESC);
