CREATE TABLE IF NOT EXISTS receipt_delivery_logs (
  receipt_id UUID PRIMARY KEY REFERENCES receipts(id) ON DELETE CASCADE,
  email_status TEXT NOT NULL DEFAULT 'not_requested' CHECK (email_status IN ('not_requested','sent','failed')),
  whatsapp_status TEXT NOT NULL DEFAULT 'not_requested' CHECK (whatsapp_status IN ('not_requested','sent','failed')),
  email_error TEXT,
  whatsapp_error TEXT,
  email_message_id TEXT,
  whatsapp_message_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
