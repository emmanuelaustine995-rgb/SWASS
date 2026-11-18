-- 020: repair staff profile columns for databases where migration 019
-- was recorded before these ALTER TABLE statements were added.
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_title TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo_data TEXT;
