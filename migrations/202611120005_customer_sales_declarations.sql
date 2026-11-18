CREATE TABLE IF NOT EXISTS customer_sales_declaration_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  declaration_ref TEXT NOT NULL UNIQUE,
  seller_name TEXT NOT NULL,
  product_name TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review','approved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID
);
CREATE INDEX IF NOT EXISTS customer_sales_declaration_owner_created
  ON customer_sales_declaration_submissions(customer_id, created_at DESC);
