-- Archive non-admin login accounts while preserving all business, receipt and sales history.
-- Partial unique indexes let a former user register again with the same phone / ID
-- after an administrator deactivates the old login account.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_phone_key;
CREATE UNIQUE INDEX IF NOT EXISTS users_active_phone_unique
  ON users(phone) WHERE is_active=true;

DROP INDEX IF EXISTS users_national_id_number_unique;
CREATE UNIQUE INDEX users_active_national_id_number_unique
  ON users(national_id_number)
  WHERE is_active=true AND national_id_number IS NOT NULL AND national_id_number <> '';

ALTER TABLE customer_accounts DROP CONSTRAINT IF EXISTS customer_accounts_phone_key;
CREATE UNIQUE INDEX IF NOT EXISTS customer_accounts_active_phone_unique
  ON customer_accounts(phone) WHERE is_active=true;

DROP INDEX IF EXISTS customer_accounts_national_id_hash_unique;
CREATE UNIQUE INDEX customer_accounts_active_national_id_hash_unique
  ON customer_accounts(national_id_hash)
  WHERE is_active=true AND national_id_hash IS NOT NULL;
