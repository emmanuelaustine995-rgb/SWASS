-- 005: rules the database enforces so application bugs cannot break them

ALTER TABLE wallet_transactions
  ADD CONSTRAINT wallet_tx_receipt_fk FOREIGN KEY (receipt_id) REFERENCES receipts(id);

-- A receipt is charged the KSh 2 fee at most once (protects against sync retries).
CREATE UNIQUE INDEX uniq_receipt_fee ON wallet_transactions (receipt_id)
  WHERE reason = 'receipt_fee';

-- Loyalty points for a purchase are awarded at most once per receipt.
CREATE UNIQUE INDEX uniq_loyalty_purchase ON loyalty_ledger (receipt_id)
  WHERE reason = 'purchase';

-- Receipts are never edited: only the status may change (void / return).
CREATE FUNCTION receipts_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id      IS DISTINCT FROM OLD.tenant_id
  OR NEW.store_id       IS DISTINCT FROM OLD.store_id
  OR NEW.receipt_no     IS DISTINCT FROM OLD.receipt_no
  OR NEW.cashier_id     IS DISTINCT FROM OLD.cashier_id
  OR NEW.customer_id    IS DISTINCT FROM OLD.customer_id
  OR NEW.subtotal_kes   IS DISTINCT FROM OLD.subtotal_kes
  OR NEW.discount_kes   IS DISTINCT FROM OLD.discount_kes
  OR NEW.total_kes      IS DISTINCT FROM OLD.total_kes
  OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
  OR NEW.qr_token       IS DISTINCT FROM OLD.qr_token
  OR NEW.client_uuid    IS DISTINCT FROM OLD.client_uuid
  OR NEW.issued_at      IS DISTINCT FROM OLD.issued_at THEN
    RAISE EXCEPTION 'receipts are immutable; only status may change';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_receipts_immutable BEFORE UPDATE ON receipts
  FOR EACH ROW EXECUTE FUNCTION receipts_immutable();

CREATE FUNCTION receipts_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'receipts cannot be deleted; void them instead';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_receipts_no_delete BEFORE DELETE ON receipts
  FOR EACH ROW EXECUTE FUNCTION receipts_no_delete();
