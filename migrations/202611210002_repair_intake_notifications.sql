-- Create the original register here as well as extending it so a fresh
-- database can apply migrations before the API's lazy schema initializer runs.
CREATE TABLE IF NOT EXISTS shop_repair_jobs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  received_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  item_name VARCHAR(160) NOT NULL,
  item_identifier VARCHAR(100) NOT NULL DEFAULT '',
  customer_name VARCHAR(160) NOT NULL,
  customer_id TEXT NOT NULL,
  item_condition VARCHAR(1000) NOT NULL,
  problem VARCHAR(2000) NOT NULL,
  detected VARCHAR(2000) NOT NULL DEFAULT '',
  received_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_pick_date DATE NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'received' CHECK (status IN ('received','diagnosing','in_repair','ready','collected','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
