-- One KSh 10 payment unlocks every receipt matching the same verified ID and phone.
CREATE TABLE IF NOT EXISTS receipt_recovery_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT NOT NULL CHECK (phone ~ '^254[17][0-9]{8}$'),
  national_id_hash TEXT NOT NULL,
  amount_kes BIGINT NOT NULL DEFAULT 10 CHECK (amount_kes = 10),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed')),
  checkout_request_id TEXT UNIQUE,
  mpesa_receipt_no TEXT UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_receipt_recovery_payments_lookup
  ON receipt_recovery_payments (phone,national_id_hash,status,created_at DESC);
