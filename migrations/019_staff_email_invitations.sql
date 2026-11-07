-- 019: email-based staff invitations; no shared access codes
CREATE TABLE IF NOT EXISTS staff_email_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id),
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  job_title TEXT NOT NULL DEFAULT 'Shop Attendant',
  profile_photo_data TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_by UUID REFERENCES users(id),
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_staff_email_invites_tenant
  ON staff_email_invitations(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_email_invites_email
  ON staff_email_invitations(lower(email));

ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_title TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo_data TEXT;

-- Expire any unfinished legacy cashier code-based signup requests.
UPDATE signup_otp_requests SET expires_at=now() WHERE role='cashier' AND consumed_at IS NULL;
