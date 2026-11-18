-- Public shop directory listings are opt-in and separate from private POS inventory.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS public_listing BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS products_public_directory_idx
  ON products (name, tenant_id, store_id)
  WHERE public_listing = true AND archived_at IS NULL AND stock_qty > 0;
