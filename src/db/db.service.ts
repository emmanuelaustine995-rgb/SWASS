import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';

@Injectable()
export class DbService implements OnModuleDestroy {
  // Never leave a login or other API request waiting forever when the
  // Render database is unreachable or a query is stuck.
  readonly pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    query_timeout: 20000,
    keepAlive: true,
  });

  private securitySchemaPromise: Promise<void> | null = null;

  async ensureSecuritySchema(): Promise<void> {
    if (!this.securitySchemaPromise) {
      this.securitySchemaPromise = this.pool.query(`
        CREATE TABLE IF NOT EXISTS aurora_security_events (
          id BIGSERIAL PRIMARY KEY, event_type VARCHAR(80) NOT NULL,
          severity VARCHAR(16) NOT NULL DEFAULT 'info', outcome VARCHAR(24) NOT NULL DEFAULT 'observed',
          actor_user_id UUID NULL, source_ip VARCHAR(80) NULL, user_agent VARCHAR(300) NULL,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS aurora_security_events_created_idx ON aurora_security_events(created_at DESC);
        CREATE INDEX IF NOT EXISTS aurora_security_events_type_idx ON aurora_security_events(event_type, created_at DESC);
        CREATE INDEX IF NOT EXISTS aurora_security_events_ip_idx ON aurora_security_events(source_ip, created_at DESC);
      `).then(() => undefined).catch(err => { this.securitySchemaPromise = null; throw err; });
    }
    await this.securitySchemaPromise;
  }

  async recordSecurityEvent(input: {
    eventType: string; severity?: string; outcome?: string; actorUserId?: string | null;
    sourceIp?: string | null; userAgent?: string | null; metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.ensureSecuritySchema();
    await this.pool.query(
      `INSERT INTO aurora_security_events
       (event_type,severity,outcome,actor_user_id,source_ip,user_agent,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [input.eventType.slice(0,80), input.severity || 'info', input.outcome || 'observed',
       input.actorUserId || null, input.sourceIp?.slice(0,80) || null,
       input.userAgent?.slice(0,300) || null, JSON.stringify(input.metadata || {})],
    );
  }

  /** Runs fn inside one transaction; rolls back if it throws. */
  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  onModuleDestroy() {
    return this.pool.end();
  }
}
