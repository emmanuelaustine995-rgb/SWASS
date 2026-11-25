-- Route customer-submitted declarations to exactly one registered AURORA shop.
ALTER TABLE customer_sales_declaration_submissions
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE customer_sales_declaration_submissions
  ADD COLUMN IF NOT EXISTS target_shop_phone TEXT;
CREATE INDEX IF NOT EXISTS customer_sales_declarations_tenant_created
  ON customer_sales_declaration_submissions(tenant_id, created_at DESC)
  WHERE tenant_id IS NOT NULL;
