-- Link completed repair handovers to normal SWASS payment receipts.
ALTER TABLE shop_repair_jobs ADD COLUMN IF NOT EXISTS repair_cost_kes BIGINT NOT NULL DEFAULT 0;
ALTER TABLE shop_repair_jobs ADD COLUMN IF NOT EXISTS payment_client_uuid UUID;
ALTER TABLE shop_repair_jobs ADD COLUMN IF NOT EXISTS payment_total_kes BIGINT;
ALTER TABLE shop_repair_jobs ADD COLUMN IF NOT EXISTS payment_method VARCHAR(16);
ALTER TABLE shop_repair_jobs ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(24);
ALTER TABLE shop_repair_jobs ADD COLUMN IF NOT EXISTS payment_receipt_id UUID REFERENCES receipts(id);
ALTER TABLE shop_repair_jobs ADD COLUMN IF NOT EXISTS payment_receipt_no VARCHAR(80);
ALTER TABLE shop_repair_jobs ADD COLUMN IF NOT EXISTS collected_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS shop_repair_jobs_payment_client_uuid_idx ON shop_repair_jobs(tenant_id,payment_client_uuid) WHERE payment_client_uuid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shop_repair_jobs_payment_receipt_id_idx ON shop_repair_jobs(payment_receipt_id) WHERE payment_receipt_id IS NOT NULL;
