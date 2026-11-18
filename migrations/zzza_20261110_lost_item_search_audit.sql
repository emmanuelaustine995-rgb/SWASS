-- Add police occurrence reference and a minimal audit trail for lost-item searches.
ALTER TABLE lost_items ADD COLUMN IF NOT EXISTS ob_number TEXT;

CREATE TABLE IF NOT EXISTS lost_item_searches (
  id BIGSERIAL PRIMARY KEY,
  item_code TEXT NOT NULL,
  identifier TEXT NOT NULL,
  searched_by_user_id TEXT,
  searched_by_phone TEXT,
  searched_by_name TEXT,
  searched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lost_item_searches_latest
  ON lost_item_searches(item_code, searched_at DESC);
