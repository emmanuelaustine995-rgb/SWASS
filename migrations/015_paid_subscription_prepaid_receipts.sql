-- 015: enforce paid subscriptions and fully prepaid receipt wallet.
-- New and existing businesses must have an active paid subscription to use SWASS.
-- Remove signup-created trial subscriptions; successful M-Pesa subscriptions remain valid.
UPDATE subscriptions s
   SET status='expired'
 WHERE s.status='active'
   AND NOT EXISTS (
     SELECT 1 FROM payments p
      WHERE p.tenant_id=s.tenant_id
        AND p.purpose='subscription'
        AND p.status='success'
   );

-- Receipt credits are strictly prepaid. Clear any legacy overdraft debt and
-- disable overdraft for all wallets, including wallets created before this migration.
UPDATE wallets
   SET balance_kes=GREATEST(balance_kes,0),
       overdraft_limit_kes=0;
ALTER TABLE wallets ALTER COLUMN overdraft_limit_kes SET DEFAULT 0;
ALTER TABLE wallets ALTER COLUMN overdraft_limit_kes SET NOT NULL;
