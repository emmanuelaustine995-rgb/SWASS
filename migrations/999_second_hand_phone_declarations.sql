CREATE TABLE IF NOT EXISTS second_hand_phone_declarations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  store_id UUID NOT NULL,
  recorded_by UUID NOT NULL,
  declaration_ref TEXT NOT NULL UNIQUE,
  seller_name TEXT NOT NULL,
  national_id TEXT NOT NULL,
  seller_phone TEXT NOT NULL,
  alternative_phone TEXT,
  residential_address TEXT NOT NULL,
  phone_make_model TEXT NOT NULL,
  imei1 TEXT NOT NULL,
  imei2 TEXT,
  serial_number TEXT,
  phone_condition TEXT NOT NULL,
  purchase_price_kes BIGINT NOT NULL CHECK (purchase_price_kes > 0),
  no_receipt_reason TEXT NOT NULL,
  seller_photo_data TEXT,
  id_photo_data TEXT NOT NULL,
  phone_photo_data TEXT NOT NULL,
  signature_data TEXT NOT NULL,
  thumbprint_data TEXT NOT NULL,
  witness_name TEXT,
  witness_phone TEXT,
  declaration_accepted BOOLEAN NOT NULL DEFAULT false,
  shop_acknowledged BOOLEAN NOT NULL DEFAULT false,
  shop_acknowledged_at TIMESTAMPTZ,
  declaration_version TEXT NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS second_hand_phone_declarations_shop_created_idx
  ON second_hand_phone_declarations (tenant_id, store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS second_hand_phone_declarations_imei_idx
  ON second_hand_phone_declarations (tenant_id, store_id, imei1);
