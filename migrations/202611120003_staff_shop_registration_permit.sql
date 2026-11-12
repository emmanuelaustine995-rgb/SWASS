ALTER TABLE staff_email_invitations
  ADD COLUMN IF NOT EXISTS shop_registration_permit TEXT;
