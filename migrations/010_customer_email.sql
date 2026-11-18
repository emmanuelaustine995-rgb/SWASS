-- 010: optional customer email for digital receipts and customer records.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email TEXT;
CREATE INDEX IF NOT EXISTS idx_customers_tenant_email ON customers (tenant_id, email) WHERE email IS NOT NULL;
