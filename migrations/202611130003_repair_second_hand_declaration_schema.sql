-- Repair legacy second-hand declaration tables created before the full declaration schema.
-- CREATE TABLE IF NOT EXISTS does not add columns to an already-existing table.
ALTER TABLE second_hand_phone_declarations
  ADD COLUMN IF NOT EXISTS seller_email TEXT,
  ADD COLUMN IF NOT EXISTS buyer_name TEXT,
  ADD COLUMN IF NOT EXISTS buyer_national_id TEXT,
  ADD COLUMN IF NOT EXISTS buyer_phone TEXT,
  ADD COLUMN IF NOT EXISTS buyer_email TEXT,
  ADD COLUMN IF NOT EXISTS sale_type TEXT NOT NULL DEFAULT 'without_receipt',
  ADD COLUMN IF NOT EXISTS receipt_photo_data TEXT,
  ADD COLUMN IF NOT EXISTS shop_acknowledged BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shop_acknowledged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS declaration_accepted BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS declaration_version TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;

ALTER TABLE second_hand_phone_declarations
  DROP CONSTRAINT IF EXISTS second_hand_phone_declarations_sale_type_check;
ALTER TABLE second_hand_phone_declarations
  ADD CONSTRAINT second_hand_phone_declarations_sale_type_check
  CHECK (sale_type IN ('with_receipt', 'without_receipt'));

CREATE INDEX IF NOT EXISTS second_hand_declarations_buyer_phone_idx
  ON second_hand_phone_declarations (tenant_id, store_id, buyer_phone);
