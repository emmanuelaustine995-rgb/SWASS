-- 006: bind an offline idempotency key to the exact sale payload.
-- The value is an HMAC, not raw customer data or a reversible representation.
ALTER TABLE receipts ADD COLUMN request_hash TEXT;
ALTER TABLE receipts ADD CONSTRAINT receipts_request_hash_format
  CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');
