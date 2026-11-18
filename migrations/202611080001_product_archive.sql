-- Hide existing catalogue entries without deleting products referenced by old receipts.
ALTER TABLE products ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS products_active_store_idx
  ON products (tenant_id, store_id, name)
  WHERE archived_at IS NULL;
