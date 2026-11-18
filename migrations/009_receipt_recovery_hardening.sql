-- Recovery OTPs are short-lived, single-use and attempt-limited.
ALTER TABLE otp_requests ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_recovery_sessions_expiry ON recovery_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_otp_expiry ON otp_requests(expires_at);
