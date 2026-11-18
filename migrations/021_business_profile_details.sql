-- 021: optional legal, contact and outlet details for business profiles
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS legal_name TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS website_url TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS kra_pin TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS registration_code TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS house_name TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS floor TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS house_number TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS outlet_id TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS terminal_number TEXT;
ALTER TABLE signup_otp_requests ADD COLUMN IF NOT EXISTS house_name TEXT;
ALTER TABLE signup_otp_requests ADD COLUMN IF NOT EXISTS floor TEXT;
ALTER TABLE signup_otp_requests ADD COLUMN IF NOT EXISTS house_number TEXT;
ALTER TABLE signup_otp_requests ADD COLUMN IF NOT EXISTS website_url TEXT;
ALTER TABLE signup_otp_requests ADD COLUMN IF NOT EXISTS kra_pin TEXT;

ALTER TABLE signup_otp_requests ADD COLUMN IF NOT EXISTS legal_name TEXT;
ALTER TABLE signup_otp_requests ADD COLUMN IF NOT EXISTS business_email TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS legal_name TEXT;
