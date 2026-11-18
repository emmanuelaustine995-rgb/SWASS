ALTER TABLE aurora_admin_identity_records
  ADD COLUMN IF NOT EXISTS admin_password_hash TEXT;

-- Existing linked administrator records can continue using their existing
-- user password until they complete the new linked-account registration flow.
