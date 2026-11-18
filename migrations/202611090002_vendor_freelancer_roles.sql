-- Vendor and freelancer accounts can use the complete shop workspace.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('super_admin','owner','manager','cashier','vendor','freelancer'));
