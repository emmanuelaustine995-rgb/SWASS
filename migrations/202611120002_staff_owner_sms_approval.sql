-- Owner phone approval for each freelancer/vendor invitation.
ALTER TABLE staff_email_invitations ADD COLUMN IF NOT EXISTS approval_code_hash TEXT;
ALTER TABLE staff_email_invitations ADD COLUMN IF NOT EXISTS approval_expires_at TIMESTAMPTZ;
ALTER TABLE staff_email_invitations ADD COLUMN IF NOT EXISTS approval_attempts INTEGER NOT NULL DEFAULT 0;
