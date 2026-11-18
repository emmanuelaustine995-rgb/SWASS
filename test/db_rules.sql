-- Verifies the integrity rules in the migrations. Everything runs in one
-- transaction that is rolled back, so it leaves no data behind.
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f test/db_rules.sql
BEGIN;

DO $$
DECLARE
  t UUID; s UUID; u UUID; c UUID; p UUID; r UUID; r2 UUID;
  failed BOOLEAN;
BEGIN
  INSERT INTO tenants (name, phone) VALUES ('Test Shop', '0712000000') RETURNING id INTO t;
  INSERT INTO stores (tenant_id, name) VALUES (t, 'Main') RETURNING id INTO s;
  INSERT INTO users (tenant_id, store_id, full_name, phone, password_hash, role)
    VALUES (t, s, 'Faith', '0711000001', 'x', 'cashier') RETURNING id INTO u;
  INSERT INTO customers (tenant_id, full_name, phone, national_id_hash, national_id_last4)
    VALUES (t, 'J Kamau', '0712345678', 'hash', '4321') RETURNING id INTO c;
  INSERT INTO products (tenant_id, store_id, name, price_kes, stock_qty)
    VALUES (t, s, 'Phone', 18500, 1) RETURNING id INTO p;
  INSERT INTO wallets (tenant_id, balance_kes) VALUES (t, 10);

  -- 1. a valid receipt is accepted
  INSERT INTO receipts (tenant_id, store_id, receipt_no, cashier_id, customer_id,
      subtotal_kes, discount_kes, total_kes, payment_method, qr_token, client_uuid, issued_at)
    VALUES (t, s, 'N1-1', u, c, 19100, 100, 19000, 'mpesa', 'tok1',
      '11111111-1111-1111-1111-111111111111', now()) RETURNING id INTO r;

  -- 2. same offline client_uuid is rejected (no duplicate on sync retry)
  failed := false;
  BEGIN
    INSERT INTO receipts (tenant_id, store_id, receipt_no, cashier_id, subtotal_kes, total_kes,
        payment_method, qr_token, client_uuid, issued_at)
      VALUES (t, s, 'N1-2', u, 100, 100, 'cash', 'tok2', '11111111-1111-1111-1111-111111111111', now());
  EXCEPTION WHEN unique_violation THEN failed := true; END;
  IF NOT failed THEN RAISE EXCEPTION 'FAIL: duplicate client_uuid accepted'; END IF;

  -- 3. total must equal subtotal minus discount
  failed := false;
  BEGIN
    INSERT INTO receipts (tenant_id, store_id, receipt_no, cashier_id, subtotal_kes, discount_kes,
        total_kes, payment_method, qr_token, client_uuid, issued_at)
      VALUES (t, s, 'N1-3', u, 1000, 100, 1000, 'cash', 'tok3', gen_random_uuid(), now());
  EXCEPTION WHEN check_violation THEN failed := true; END;
  IF NOT failed THEN RAISE EXCEPTION 'FAIL: inconsistent totals accepted'; END IF;

  -- 4. line total must equal qty x unit price
  failed := false;
  BEGIN
    INSERT INTO receipt_items (receipt_id, product_id, name, qty, unit_price_kes, line_total_kes)
      VALUES (r, p, 'Phone', 2, 300, 500);
  EXCEPTION WHEN check_violation THEN failed := true; END;
  IF NOT failed THEN RAISE EXCEPTION 'FAIL: bad line total accepted'; END IF;

  -- 5. the KSh 2 fee can be charged only once per receipt
  INSERT INTO wallet_transactions (tenant_id, change_kes, reason, receipt_id) VALUES (t, -2, 'receipt_fee', r);
  failed := false;
  BEGIN
    INSERT INTO wallet_transactions (tenant_id, change_kes, reason, receipt_id) VALUES (t, -2, 'receipt_fee', r);
  EXCEPTION WHEN unique_violation THEN failed := true; END;
  IF NOT failed THEN RAISE EXCEPTION 'FAIL: receipt fee charged twice'; END IF;

  -- 6. wallet may dip into the overdraft limit (default 100) but not beyond it
  UPDATE wallets SET balance_kes = -100 WHERE tenant_id = t;
  failed := false;
  BEGIN
    UPDATE wallets SET balance_kes = -101 WHERE tenant_id = t;
  EXCEPTION WHEN check_violation THEN failed := true; END;
  IF NOT failed THEN RAISE EXCEPTION 'FAIL: wallet exceeded overdraft limit'; END IF;

  -- 7. loyalty points awarded once per receipt
  INSERT INTO loyalty_ledger (customer_id, receipt_id, points, reason) VALUES (c, r, 19, 'purchase');
  failed := false;
  BEGIN
    INSERT INTO loyalty_ledger (customer_id, receipt_id, points, reason) VALUES (c, r, 19, 'purchase');
  EXCEPTION WHEN unique_violation THEN failed := true; END;
  IF NOT failed THEN RAISE EXCEPTION 'FAIL: loyalty awarded twice'; END IF;

  -- 8. receipts cannot be edited, but status can change
  failed := false;
  BEGIN
    UPDATE receipts SET total_kes = 1, subtotal_kes = 1, discount_kes = 0 WHERE id = r;
  EXCEPTION WHEN raise_exception THEN failed := true; END;
  IF NOT failed THEN RAISE EXCEPTION 'FAIL: receipt amounts were editable'; END IF;
  UPDATE receipts SET status = 'voided' WHERE id = r;

  -- 9. receipts cannot be deleted
  failed := false;
  BEGIN
    DELETE FROM receipts WHERE id = r;
  EXCEPTION WHEN raise_exception THEN failed := true; END;
  IF NOT failed THEN RAISE EXCEPTION 'FAIL: receipt was deletable'; END IF;

  -- 10. stock may go negative (offline sale of an item already sold out)
  UPDATE products SET stock_qty = stock_qty - 3 WHERE id = p;

  -- 11. only super_admin may have no tenant
  failed := false;
  BEGIN
    INSERT INTO users (tenant_id, full_name, phone, password_hash, role)
      VALUES (NULL, 'Ghost', '0700000000', 'x', 'owner');
  EXCEPTION WHEN check_violation THEN failed := true; END;
  IF NOT failed THEN RAISE EXCEPTION 'FAIL: tenant-less owner accepted'; END IF;

  -- 12. subscription price must match a real plan
  failed := false;
  BEGIN
    INSERT INTO subscriptions (tenant_id, plan, price_kes, starts_at, ends_at, status)
      VALUES (t, 'monthly', 50, now(), now() + interval '1 month', 'active');
  EXCEPTION WHEN check_violation THEN failed := true; END;
  IF NOT failed THEN RAISE EXCEPTION 'FAIL: invalid plan price accepted'; END IF;

  RAISE NOTICE 'ALL 12 DATABASE RULE CHECKS PASSED';
END $$;

ROLLBACK;
