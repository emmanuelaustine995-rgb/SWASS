-- Extend the existing Shop Goods > Repair register with intake references,
-- contact details, owner notification context and an immutable activity trail.
ALTER TABLE shop_repair_jobs
  ADD COLUMN IF NOT EXISTS reference VARCHAR(40),
  ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(30) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS customer_email VARCHAR(254) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS accessories VARCHAR(500) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS received_by_name VARCHAR(160) NOT NULL DEFAULT 'Shop team';

CREATE UNIQUE INDEX IF NOT EXISTS shop_repair_jobs_reference_idx
  ON shop_repair_jobs(reference) WHERE reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS shop_repair_jobs_customer_phone_idx
  ON shop_repair_jobs(customer_phone);

CREATE TABLE IF NOT EXISTS shop_repair_events (
  id BIGSERIAL PRIMARY KEY,
  repair_id BIGINT NOT NULL REFERENCES shop_repair_jobs(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  actor_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  actor_name VARCHAR(160) NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shop_repair_events_repair_idx
  ON shop_repair_events(repair_id, created_at DESC);
