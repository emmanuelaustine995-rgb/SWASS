-- Reconcile older second-hand declaration tables with the current API schema.
-- This file deliberately sorts after 999_* and zzz_* migrations because those
-- create the table and add the receipt/amendment fields before this repair runs.
ALTER TABLE second_hand_phone_declarations
  ADD COLUMN IF NOT EXISTS seller_email TEXT,
  ADD COLUMN IF NOT EXISTS buyer_name TEXT,
  ADD COLUMN IF NOT EXISTS buyer_national_id TEXT,
  ADD COLUMN IF NOT EXISTS buyer_phone TEXT,
  ADD COLUMN IF NOT EXISTS buyer_email TEXT,
  ADD COLUMN IF NOT EXISTS sale_type TEXT NOT NULL DEFAULT 'without_receipt',
  ADD COLUMN IF NOT EXISTS receipt_photo_data TEXT,
  ADD COLUMN IF NOT EXISTS seller_photo_data TEXT,
  ADD COLUMN IF NOT EXISTS id_photo_data TEXT,
  ADD COLUMN IF NOT EXISTS phone_photo_data TEXT,
  ADD COLUMN IF NOT EXISTS signature_data TEXT,
  ADD COLUMN IF NOT EXISTS thumbprint_data TEXT,
  ADD COLUMN IF NOT EXISTS witness_name TEXT,
  ADD COLUMN IF NOT EXISTS witness_phone TEXT,
  ADD COLUMN IF NOT EXISTS declaration_accepted BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shop_acknowledged BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shop_acknowledged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS declaration_version TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;

-- Existing rows from older versions pre-date the receipt/no-receipt choice.
UPDATE second_hand_phone_declarations
   SET sale_type = 'without_receipt'
 WHERE sale_type IS NULL OR sale_type NOT IN ('with_receipt', 'without_receipt');

ALTER TABLE second_hand_phone_declarations
  ALTER COLUMN sale_type SET DEFAULT 'without_receipt',
  ALTER COLUMN sale_type SET NOT NULL,
  DROP CONSTRAINT IF EXISTS second_hand_phone_declarations_sale_type_check;

ALTER TABLE second_hand_phone_declarations
  ADD CONSTRAINT second_hand_phone_declarations_sale_type_check
  CHECK (sale_type IN ('with_receipt', 'without_receipt'));

CREATE INDEX IF NOT EXISTS second_hand_declarations_buyer_phone_idx
  ON second_hand_phone_declarations (tenant_id, store_id, buyer_phone);
