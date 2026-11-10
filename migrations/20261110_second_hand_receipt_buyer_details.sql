ALTER TABLE second_hand_phone_declarations
  ADD COLUMN IF NOT EXISTS seller_email TEXT,
  ADD COLUMN IF NOT EXISTS buyer_name TEXT,
  ADD COLUMN IF NOT EXISTS buyer_national_id TEXT,
  ADD COLUMN IF NOT EXISTS buyer_phone TEXT,
  ADD COLUMN IF NOT EXISTS buyer_email TEXT;

CREATE INDEX IF NOT EXISTS second_hand_declarations_buyer_phone_idx
  ON second_hand_phone_declarations (tenant_id, store_id, buyer_phone);
