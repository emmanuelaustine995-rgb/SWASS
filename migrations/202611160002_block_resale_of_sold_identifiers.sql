-- Prevent a previously sold phone/electronic identifier from being sold again as NEW.
-- Enforcement runs inside the receipt transaction with a PostgreSQL advisory lock,
-- so concurrent tills cannot both pass the duplicate check.
-- Historical receipts are retained unchanged.
CREATE INDEX IF NOT EXISTS receipt_items_normalized_serial_lookup_idx
  ON receipt_items (upper(regexp_replace(COALESCE(serial_no, ''), '[^A-Za-z0-9]', '', 'g')))
  WHERE serial_no IS NOT NULL AND btrim(serial_no) <> '';
