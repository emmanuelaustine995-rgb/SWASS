-- AURORA starts with a new, empty schema. No SWASS business data is copied.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS aurora_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS aurora_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES aurora_tenants(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  email text,
  phone text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','cashier')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone)
);
CREATE UNIQUE INDEX IF NOT EXISTS aurora_users_phone_global_unique ON aurora_users(phone);
CREATE TABLE IF NOT EXISTS aurora_business_profiles (
  tenant_id uuid PRIMARY KEY REFERENCES aurora_tenants(id) ON DELETE CASCADE,
  business_name text NOT NULL,
  phone text,
  email text,
  address text,
  tax_pin text,
  logo_url text,
  receipt_header text,
  receipt_footer text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS aurora_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES aurora_tenants(id) ON DELETE CASCADE,
  receipt_no text NOT NULL,
  customer_name text,
  customer_phone text,
  customer_email text,
  payment_method text NOT NULL CHECK (payment_method IN ('cash','mpesa','card','bank_transfer')),
  subtotal_kes numeric(14,2) NOT NULL CHECK (subtotal_kes >= 0),
  tax_kes numeric(14,2) NOT NULL DEFAULT 0 CHECK (tax_kes >= 0),
  total_kes numeric(14,2) NOT NULL CHECK (total_kes >= 0),
  issued_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES aurora_users(id),
  UNIQUE (tenant_id, receipt_no)
);
CREATE TABLE IF NOT EXISTS aurora_receipt_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES aurora_receipts(id) ON DELETE CASCADE,
  product_name text NOT NULL,
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_price_kes numeric(14,2) NOT NULL CHECK (unit_price_kes >= 0),
  line_total_kes numeric(14,2) NOT NULL CHECK (line_total_kes >= 0)
);
CREATE INDEX IF NOT EXISTS aurora_receipts_tenant_date_idx ON aurora_receipts(tenant_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS aurora_receipts_tenant_phone_idx ON aurora_receipts(tenant_id, customer_phone);
