-- One-time KSh 50 vendor activation fee. Freelancers are not charged.
CREATE TABLE IF NOT EXISTS vendor_invitation_fees (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id UUID NOT NULL REFERENCES tenants(id),
 invitation_id UUID NOT NULL UNIQUE REFERENCES staff_email_invitations(id) ON DELETE CASCADE,
 payment_id UUID NOT NULL UNIQUE REFERENCES payments(id),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_vendor_invitation_fees_tenant ON vendor_invitation_fees(tenant_id,created_at DESC);
