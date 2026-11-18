-- 022: retain optional shop interior and exterior photos in the business profile.
ALTER TABLE stores ADD COLUMN IF NOT EXISTS shop_inside_photo_data TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS shop_outside_photo_data TEXT;
