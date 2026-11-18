-- 019: require shop attendants to replace their owner-issued access code on first sign-in
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
