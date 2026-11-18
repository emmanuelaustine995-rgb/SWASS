'use strict';

// Idempotent migration runner for hosts that do not provide a one-off shell.
// Safe to run at each API startup: only unapplied SQL files are executed.
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

function databaseConnectionString() {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error('DATABASE_URL must be set');
  const url = new URL(value);
  const mode = url.searchParams.get('sslmode');
  if (['prefer', 'require', 'verify-ca'].includes(mode)) url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}

async function main() {
  const pool = new Pool({ connectionString: databaseConnectionString() });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const dir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const name of files) {
      const exists = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (exists.rowCount) continue;
      const sql = fs.readFileSync(path.join(dir, name), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
        process.stdout.write(`applied ${name}\n`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    process.stdout.write('database migrations are up to date\n');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('database migration failed:', error.message);
  process.exitCode = 1;
});
