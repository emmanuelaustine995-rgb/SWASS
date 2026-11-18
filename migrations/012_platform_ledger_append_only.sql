-- Platform revenue is append-only: corrections must be represented by new, reviewed entries.
CREATE OR REPLACE FUNCTION reject_platform_ledger_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform financial ledger is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_platform_ledger_no_update ON platform_financial_ledger;
CREATE TRIGGER trg_platform_ledger_no_update
BEFORE UPDATE OR DELETE ON platform_financial_ledger
FOR EACH ROW EXECUTE FUNCTION reject_platform_ledger_mutation();
