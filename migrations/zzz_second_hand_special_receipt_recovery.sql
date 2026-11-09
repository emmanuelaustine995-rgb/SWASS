-- Run after 999_second_hand_phone_declarations.sql.
-- Separate paid recovery and immutable amendment history for second-hand special receipts.
CREATE TABLE IF NOT EXISTS second_hand_special_receipt_recoveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  declaration_id UUID NOT NULL REFERENCES second_hand_phone_declarations(id) ON DELETE CASCADE,
  phone TEXT NOT NULL CHECK (phone ~ '^254[17][0-9]{8}$'),
  amount_kes BIGINT NOT NULL DEFAULT 50 CHECK (amount_kes = 50),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed')),
  checkout_request_id TEXT UNIQUE,
  mpesa_receipt_no TEXT UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS second_hand_special_recovery_lookup_idx
  ON second_hand_special_receipt_recoveries (declaration_id, phone, status, created_at DESC);

CREATE TABLE IF NOT EXISTS second_hand_declaration_amendments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  declaration_id UUID NOT NULL REFERENCES second_hand_phone_declarations(id) ON DELETE RESTRICT,
  tenant_id UUID NOT NULL,
  store_id UUID NOT NULL,
  amended_by UUID NOT NULL,
  version_no INTEGER NOT NULL CHECK (version_no > 1),
  reason TEXT NOT NULL,
  changes JSONB NOT NULL CHECK (jsonb_typeof(changes) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (declaration_id, version_no)
);
CREATE INDEX IF NOT EXISTS second_hand_declaration_amendments_history_idx
  ON second_hand_declaration_amendments (declaration_id, version_no DESC);
