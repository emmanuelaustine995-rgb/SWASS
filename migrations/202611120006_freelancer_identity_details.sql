ALTER TABLE users
  ADD COLUMN IF NOT EXISTS national_id_number TEXT,
  ADD COLUMN IF NOT EXISTS national_id_photo_data TEXT;

ALTER TABLE staff_email_invitations
  ADD COLUMN IF NOT EXISTS national_id_number TEXT,
  ADD COLUMN IF NOT EXISTS national_id_photo_data TEXT,
  ADD COLUMN IF NOT EXISTS profile_photo_data TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS users_national_id_number_unique
  ON users (national_id_number)
  WHERE national_id_number IS NOT NULL AND national_id_number <> '';
