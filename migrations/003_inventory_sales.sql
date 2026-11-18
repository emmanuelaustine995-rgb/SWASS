-- 003: products, stock, receipts, items, deliveries, loyalty ledger
CREATE TABLE products (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  store_id          UUID NOT NULL REFERENCES stores(id),
  sku               TEXT,
  barcode           TEXT,
  name              TEXT NOT NULL,
  price_kes         BIGINT NOT NULL CHECK (price_kes >= 0),
  cost_kes          BIGINT CHECK (cost_kes >= 0),
  stock_qty         INT NOT NULL DEFAULT 0,        -- may go negative after offline sync
  reorder_level     INT NOT NULL DEFAULT 5,
  requires_buyer_id BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (store_id, barcode)
);
CREATE INDEX idx_products_low_stock ON products (tenant_id) WHERE stock_qty <= reorder_level;

CREATE TABLE receipts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  store_id       UUID NOT NULL REFERENCES stores(id),
  receipt_no     TEXT NOT NULL,
  cashier_id     UUID NOT NULL REFERENCES users(id),
  customer_id    UUID REFERENCES customers(id),
  subtotal_kes   BIGINT NOT NULL CHECK (subtotal_kes >= 0),
  discount_kes   BIGINT NOT NULL DEFAULT 0 CHECK (discount_kes >= 0),
  total_kes      BIGINT NOT NULL CHECK (total_kes >= 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','mpesa','card')),
  qr_token       TEXT NOT NULL UNIQUE,
  status         TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','voided','returned')),
  client_uuid    UUID NOT NULL UNIQUE,              -- offline idempotency key
  issued_at      TIMESTAMPTZ NOT NULL,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, receipt_no),
  CHECK (total_kes = subtotal_kes - discount_kes)
);
CREATE INDEX idx_receipts_customer ON receipts (customer_id);
CREATE INDEX idx_receipts_tenant_time ON receipts (tenant_id, issued_at DESC);

CREATE TABLE receipt_items (
  id             BIGSERIAL PRIMARY KEY,
  receipt_id     UUID NOT NULL REFERENCES receipts(id),
  product_id     UUID REFERENCES products(id),
  name           TEXT NOT NULL,
  serial_no      TEXT,
  qty            INT NOT NULL CHECK (qty > 0),
  unit_price_kes BIGINT NOT NULL CHECK (unit_price_kes >= 0),
  line_total_kes BIGINT NOT NULL CHECK (line_total_kes = qty * unit_price_kes)
);
CREATE INDEX idx_receipt_items_receipt ON receipt_items (receipt_id);

CREATE TABLE stock_movements (
  id         BIGSERIAL PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES products(id),
  change_qty INT NOT NULL,
  reason     TEXT NOT NULL CHECK (reason IN ('sale','restock','adjustment','return')),
  receipt_id UUID REFERENCES receipts(id),
  user_id    UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE receipt_deliveries (
  id          BIGSERIAL PRIMARY KEY,
  receipt_id  UUID NOT NULL REFERENCES receipts(id),
  channel     TEXT NOT NULL CHECK (channel IN ('sms','whatsapp','email','print')),
  destination TEXT,
  status      TEXT NOT NULL CHECK (status IN ('queued','sent','failed')),
  sent_at     TIMESTAMPTZ
);

CREATE TABLE loyalty_ledger (
  id          BIGSERIAL PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES customers(id),
  receipt_id  UUID REFERENCES receipts(id),
  points      INT NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN ('purchase','redeem','adjustment')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
