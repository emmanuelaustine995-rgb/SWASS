-- 004: OTP recovery and audit log
CREATE TABLE otp_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        TEXT NOT NULL,
  customer_ids UUID[] NOT NULL DEFAULT '{}',   -- empty when nothing matched
  code_hash    TEXT NOT NULL,                  -- never the raw code
  attempts     INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at   TIMESTAMPTZ NOT NULL,
  verified_at  TIMESTAMPTZ,
  ip_address   INET,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_otp_phone_time ON otp_requests (phone, created_at DESC);
CREATE INDEX idx_otp_ip_time ON otp_requests (ip_address, created_at DESC);

CREATE TABLE recovery_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  otp_request_id UUID NOT NULL REFERENCES otp_requests(id),
  token_hash     TEXT NOT NULL UNIQUE,
  expires_at     TIMESTAMPTZ NOT NULL
);

CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  UUID,
  user_id    UUID,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  reason     TEXT,
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_tenant_time ON audit_log (tenant_id, created_at DESC);
