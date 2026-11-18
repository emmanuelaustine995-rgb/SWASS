-- Add evidence fields for second-hand phone purchases where the seller has an original receipt.
ALTER TABLE second_hand_phone_declarations
  ADD COLUMN IF NOT EXISTS sale_type TEXT NOT NULL DEFAULT 'without_receipt',
  ADD COLUMN IF NOT EXISTS receipt_photo_data TEXT;

ALTER TABLE second_hand_phone_declarations
  DROP CONSTRAINT IF EXISTS second_hand_phone_declarations_sale_type_check;
ALTER TABLE second_hand_phone_declarations
  ADD CONSTRAINT second_hand_phone_declarations_sale_type_check
  CHECK (sale_type IN ('with_receipt', 'without_receipt'));
