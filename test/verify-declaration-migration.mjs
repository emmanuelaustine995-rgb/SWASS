import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for migration verification');

const repairName = 'zzzz_20261113_repair_second_hand_declaration_schema.sql';
const client = new Client({ connectionString });
await client.connect();
try {
  // Simulate an older production table whose original CREATE TABLE migration
  // was already recorded before newer declaration fields were introduced.
  await client.query(`
    ALTER TABLE second_hand_phone_declarations
      DROP CONSTRAINT IF EXISTS second_hand_phone_declarations_sale_type_check;
    ALTER TABLE second_hand_phone_declarations
      DROP COLUMN IF EXISTS seller_email CASCADE,
      DROP COLUMN IF EXISTS buyer_name CASCADE,
      DROP COLUMN IF EXISTS buyer_national_id CASCADE,
      DROP COLUMN IF EXISTS buyer_phone CASCADE,
      DROP COLUMN IF EXISTS buyer_email CASCADE,
      DROP COLUMN IF EXISTS sale_type CASCADE,
      DROP COLUMN IF EXISTS receipt_photo_data CASCADE,
      DROP COLUMN IF EXISTS shop_acknowledged CASCADE,
      DROP COLUMN IF EXISTS shop_acknowledged_at CASCADE,
      DROP COLUMN IF EXISTS declaration_accepted CASCADE,
      DROP COLUMN IF EXISTS declaration_version CASCADE,
      DROP COLUMN IF EXISTS accepted_at CASCADE;
  `);
  await client.query('DELETE FROM schema_migrations WHERE name = $1', [repairName]);
} finally {
  await client.end();
}

execFileSync(process.execPath, ['scripts/migrate.js'], { stdio: 'inherit' });

const verify = new Client({ connectionString });
await verify.connect();
try {
  const result = await verify.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'second_hand_phone_declarations'`,
  );
  const columns = new Set(result.rows.map((row) => row.column_name));
  for (const name of [
    'seller_email', 'buyer_name', 'buyer_national_id', 'buyer_phone',
    'buyer_email', 'sale_type', 'receipt_photo_data', 'shop_acknowledged',
    'shop_acknowledged_at', 'declaration_accepted', 'declaration_version', 'accepted_at',
  ]) assert.ok(columns.has(name), `Missing repaired declaration column: ${name}`);
  const applied = await verify.query('SELECT 1 FROM schema_migrations WHERE name = $1', [repairName]);
  assert.equal(applied.rowCount, 1, 'Repair migration must be recorded as applied');
  process.stdout.write('second-hand declaration legacy-schema repair verified\\n');
} finally {
  await verify.end();
}
