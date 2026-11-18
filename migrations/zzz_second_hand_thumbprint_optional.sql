-- A seller with an original purchase receipt does not need a thumbprint mark.
-- Keep the field for no-receipt declarations, where the UI requests the drawn mark.
ALTER TABLE second_hand_phone_declarations
  ALTER COLUMN thumbprint_data DROP NOT NULL;
