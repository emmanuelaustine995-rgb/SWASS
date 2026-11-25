CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  user_id UUID NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id UUID NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  public_key BYTEA NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT[],
  device_name VARCHAR(60) NOT NULL DEFAULT 'This device',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  CONSTRAINT passkeys_one_account CHECK ((user_id IS NOT NULL)::int + (customer_id IS NOT NULL)::int = 1)
);
CREATE INDEX IF NOT EXISTS passkeys_user_idx ON passkeys(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS passkeys_customer_idx ON passkeys(customer_id) WHERE customer_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  key TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS webauthn_challenges_expiry_idx ON webauthn_challenges(expires_at);
