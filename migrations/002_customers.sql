-- 002: customers and loyalty. National ID is stored only as a keyed hash.
CREATE TABLE customers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  full_name         TEXT NOT NULL,
  phone             TEXT NOT NULL,
  national_id_hash  TEXT,                       -- HMAC-SHA256(id_number, server_secret)
  national_id_last4 TEXT CHECK (national_id_last4 ~ '^[0-9A-Za-z]{4}$'),
  loyalty_points    INT NOT NULL DEFAULT 0 CHECK (loyalty_points >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone)
);
CREATE INDEX idx_customers_recovery ON customers (phone, national_id_hash);
