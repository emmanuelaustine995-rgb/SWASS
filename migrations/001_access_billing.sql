-- 001: tenants, stores, users, subscriptions, wallet, payments
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  email       TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stores (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  name           TEXT NOT NULL,
  location       TEXT,
  receipt_header TEXT,
  receipt_footer TEXT,
  UNIQUE (tenant_id, name)
);

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID REFERENCES tenants(id),          -- NULL only for super_admin
  store_id      UUID REFERENCES stores(id),
  full_name     TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,
  email         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('super_admin','owner','manager','cashier')),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((role = 'super_admin') = (tenant_id IS NULL))
);

CREATE TABLE subscriptions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  plan       TEXT NOT NULL CHECK (plan IN ('monthly','yearly')),
  price_kes  BIGINT NOT NULL CHECK (price_kes IN (100, 900)),
  starts_at  TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('active','expired','cancelled')),
  auto_renew BOOLEAN NOT NULL DEFAULT true,
  CHECK (ends_at > starts_at)
);
CREATE INDEX idx_subscriptions_tenant ON subscriptions (tenant_id, ends_at DESC);

-- Prepaid wallet for the KSh 2 per-receipt fee. A small overdraft is allowed so
-- receipts synced after an offline period are never rejected.
CREATE TABLE wallets (
  tenant_id             UUID PRIMARY KEY REFERENCES tenants(id),
  balance_kes           BIGINT NOT NULL DEFAULT 0,
  overdraft_limit_kes   BIGINT NOT NULL DEFAULT 100 CHECK (overdraft_limit_kes >= 0),
  low_balance_alert_kes BIGINT NOT NULL DEFAULT 50,
  CHECK (balance_kes >= -overdraft_limit_kes)
);

CREATE TABLE payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  purpose             TEXT NOT NULL CHECK (purpose IN ('subscription','wallet_topup')),
  amount_kes          BIGINT NOT NULL CHECK (amount_kes > 0),
  phone               TEXT NOT NULL,
  checkout_request_id TEXT UNIQUE,
  mpesa_receipt_no    TEXT UNIQUE,
  status              TEXT NOT NULL CHECK (status IN ('pending','success','failed')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wallet_transactions (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  change_kes BIGINT NOT NULL,
  reason     TEXT NOT NULL CHECK (reason IN ('topup','receipt_fee','refund')),
  receipt_id UUID,                                    -- FK added in 005
  payment_id UUID REFERENCES payments(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wallet_tx_tenant ON wallet_transactions (tenant_id, created_at DESC);
