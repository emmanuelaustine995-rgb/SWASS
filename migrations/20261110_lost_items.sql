CREATE TABLE IF NOT EXISTS lost_items (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  registered_by UUID,
  item_code TEXT NOT NULL UNIQUE,
  public_code UUID NOT NULL UNIQUE,
  item_name TEXT NOT NULL,
  brand TEXT,
  model TEXT,
  colour TEXT,
  description TEXT,
  imei_1 TEXT,
  imei_2 TEXT,
  serial_number TEXT,
  photo_data TEXT,
  purchase_date DATE,
  receipt_reference TEXT,
  status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered','lost','found','recovered','closed')),
  lost_at TIMESTAMPTZ,
  recovered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lost_items_imei1_idx ON lost_items (upper(regexp_replace(imei_1,'[^A-Za-z0-9]','','g'))) WHERE imei_1 IS NOT NULL;
CREATE INDEX IF NOT EXISTS lost_items_imei2_idx ON lost_items (upper(regexp_replace(imei_2,'[^A-Za-z0-9]','','g'))) WHERE imei_2 IS NOT NULL;
CREATE INDEX IF NOT EXISTS lost_items_serial_idx ON lost_items (upper(regexp_replace(serial_number,'[^A-Za-z0-9]','','g'))) WHERE serial_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS lost_items_tenant_store_idx ON lost_items(tenant_id,store_id,created_at DESC);
CREATE TABLE IF NOT EXISTS lost_item_reports (
  id BIGSERIAL PRIMARY KEY,
  lost_item_id BIGINT NOT NULL REFERENCES lost_items(id) ON DELETE CASCADE,
  reporter_name TEXT,
  reporter_phone TEXT,
  report_details TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  accuracy_m DOUBLE PRECISION,
  location_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lost_item_reports_item_idx ON lost_item_reports(lost_item_id,created_at DESC);
