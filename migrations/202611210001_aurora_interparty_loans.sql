-- Cross-account AURORA loans. A loan remains owned by the lender until an
-- explicitly permitted sale is approved by the lender.
CREATE TABLE IF NOT EXISTS aurora_loans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL UNIQUE,
  lender_role TEXT NOT NULL CHECK (lender_role IN ('owner','freelancer','customer')),
  lender_id UUID NOT NULL,
  lender_name TEXT NOT NULL,
  lender_phone TEXT NOT NULL,
  lender_tenant_id UUID NULL REFERENCES tenants(id) ON DELETE SET NULL,
  lender_store_id UUID NULL REFERENCES stores(id) ON DELETE SET NULL,
  borrower_role TEXT NOT NULL CHECK (borrower_role IN ('owner','freelancer','customer')),
  borrower_id UUID NOT NULL,
  borrower_name TEXT NOT NULL,
  borrower_phone TEXT NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  value_kes BIGINT NOT NULL DEFAULT 0 CHECK (value_kes >= 0),
  imei TEXT NULL,
  serial_number TEXT NULL,
  condition_out TEXT NOT NULL,
  expected_return_date DATE NOT NULL,
  selling_allowed BOOLEAN NOT NULL DEFAULT false,
  lender_authorised BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'offered'
    CHECK (status IN ('offered','active','sale_pending','return_pending','sold','returned','declined','cancelled')),
  accepted_at TIMESTAMPTZ NULL,
  closed_at TIMESTAMPTZ NULL,
  sale_report JSONB NULL,
  return_report JSONB NULL,
  last_decision_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (lender_role <> borrower_role OR lender_id <> borrower_id)
);

CREATE INDEX IF NOT EXISTS aurora_loans_lender_idx
  ON aurora_loans(lender_role, lender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS aurora_loans_borrower_idx
  ON aurora_loans(borrower_role, borrower_id, created_at DESC);
CREATE INDEX IF NOT EXISTS aurora_loans_due_idx
  ON aurora_loans(expected_return_date)
  WHERE status IN ('active','sale_pending','return_pending');

-- Prevent an individually identified device from being offered to two people
-- at the same time. A closed loan releases the identifier for future lending.
CREATE UNIQUE INDEX IF NOT EXISTS aurora_loans_active_imei_unique
  ON aurora_loans(lower(imei))
  WHERE imei IS NOT NULL AND status IN ('offered','active','sale_pending','return_pending');
CREATE UNIQUE INDEX IF NOT EXISTS aurora_loans_active_serial_unique
  ON aurora_loans(lower(serial_number))
  WHERE serial_number IS NOT NULL AND status IN ('offered','active','sale_pending','return_pending');

CREATE TABLE IF NOT EXISTS aurora_loan_activity (
  id BIGSERIAL PRIMARY KEY,
  loan_id UUID NOT NULL REFERENCES aurora_loans(id) ON DELETE CASCADE,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('owner','freelancer','customer','system')),
  actor_id UUID NULL,
  event_type TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aurora_loan_activity_loan_idx
  ON aurora_loan_activity(loan_id, created_at ASC);

CREATE OR REPLACE FUNCTION aurora_prevent_loan_activity_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AURORA loan activity is append-only';
END;
$$;
DROP TRIGGER IF EXISTS aurora_loan_activity_append_only ON aurora_loan_activity;
CREATE TRIGGER aurora_loan_activity_append_only
  BEFORE UPDATE OR DELETE ON aurora_loan_activity
  FOR EACH ROW EXECUTE FUNCTION aurora_prevent_loan_activity_mutation();
