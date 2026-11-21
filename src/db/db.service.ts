import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';

@Injectable()
export class DbService implements OnModuleDestroy, OnModuleInit {
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

  private freelancerSubscriptionSchemaPromise: Promise<void> | null = null;

  async onModuleInit(): Promise<void> {
    await this.ensureFreelancerSubscriptionSchema();
    await this.ensurePaymentPurposeSchema();
  }

  // Keep the live database constraint aligned with the payment purposes
  // accepted by MpesaController. This is safe to run on every startup.
  private paymentPurposeSchemaPromise: Promise<void> | null = null;

  async ensurePaymentPurposeSchema(): Promise<void> {
    if (!this.paymentPurposeSchemaPromise) {
      this.paymentPurposeSchemaPromise = this.pool.query(`
        ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_purpose_check;
        ALTER TABLE payments ADD CONSTRAINT payments_purpose_check
          CHECK (purpose IN ('subscription','wallet_topup','vendor_fee','receipt_sale'));
      `).then(() => undefined).catch(err => {
        this.paymentPurposeSchemaPromise = null;
        throw err;
      });
    }
    await this.paymentPurposeSchemaPromise;
  }

  async ensureFreelancerSubscriptionSchema(): Promise<void> {
    if (!this.freelancerSubscriptionSchemaPromise) {
      this.freelancerSubscriptionSchemaPromise = this.pool.query(`
        ALTER TABLE payments ADD COLUMN IF NOT EXISTS subscriber_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS payments_subscriber_user_idx ON payments(subscriber_user_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS freelancer_subscriptions (
          id BIGSERIAL PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          payment_id UUID NOT NULL UNIQUE REFERENCES payments(id) ON DELETE RESTRICT,
          plan VARCHAR(16) NOT NULL CHECK (plan IN ('monthly','yearly')),
          price_kes INTEGER NOT NULL CHECK (price_kes IN (100,900)),
          starts_at TIMESTAMPTZ NOT NULL,
          ends_at TIMESTAMPTZ NOT NULL,
          status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','cancelled')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS freelancer_subscriptions_user_expiry_idx
          ON freelancer_subscriptions(user_id, ends_at DESC);
      `).then(() => undefined).catch(err => { this.freelancerSubscriptionSchemaPromise = null; throw err; });
    }
    await this.freelancerSubscriptionSchemaPromise;
  }

  private securitySchemaPromise: Promise<void> | null = null;
  private operationsSchemaPromise: Promise<void> | null = null;

  async ensureOperationsSchema(): Promise<void> {
    if (!this.operationsSchemaPromise) {
      this.operationsSchemaPromise = this.pool.query(
        'CREATE TABLE IF NOT EXISTS aurora_platform_operations (id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id=1), maintenance_enabled BOOLEAN NOT NULL DEFAULT false, maintenance_title VARCHAR(120) NOT NULL DEFAULT \'Scheduled maintenance\', maintenance_message VARCHAR(600) NOT NULL DEFAULT \'AURORA is temporarily unavailable while we improve our services. Please try again shortly.\', maintenance_starts_at TIMESTAMPTZ NULL, updated_by UUID NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()); INSERT INTO aurora_platform_operations (id) VALUES (1) ON CONFLICT (id) DO NOTHING;'
      ).then(() => undefined).catch(err => { this.operationsSchemaPromise = null; throw err; });
    }
    await this.operationsSchemaPromise;
  }


  private repairSchemaPromise: Promise<void> | null = null;

  async ensureRepairSchema(): Promise<void> {
    if (!this.repairSchemaPromise) {
      this.repairSchemaPromise = this.pool.query(`
        CREATE TABLE IF NOT EXISTS shop_repair_jobs (
          id BIGSERIAL PRIMARY KEY,
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
          received_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
          item_name VARCHAR(160) NOT NULL,
          item_identifier VARCHAR(100) NOT NULL DEFAULT '',
          customer_name VARCHAR(160) NOT NULL,
          customer_id TEXT NOT NULL,
          item_condition VARCHAR(1000) NOT NULL,
          problem VARCHAR(2000) NOT NULL,
          detected VARCHAR(2000) NOT NULL DEFAULT '',
          received_date DATE NOT NULL DEFAULT CURRENT_DATE,
          expected_pick_date DATE NOT NULL,
          status VARCHAR(24) NOT NULL DEFAULT 'received' CHECK (status IN ('received','diagnosing','in_repair','ready','collected','cancelled')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        ALTER TABLE shop_repair_jobs ADD COLUMN IF NOT EXISTS item_identifier VARCHAR(100) NOT NULL DEFAULT '';
        ALTER TABLE shop_repair_jobs ADD COLUMN IF NOT EXISTS reference VARCHAR(40);
        ALTER TABLE shop_repair_jobs ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(30) NOT NULL DEFAULT '';
        ALTER TABLE shop_repair_jobs ADD COLUMN IF NOT EXISTS customer_email VARCHAR(254) NOT NULL DEFAULT '';
        ALTER TABLE shop_repair_jobs ADD COLUMN IF NOT EXISTS accessories VARCHAR(500) NOT NULL DEFAULT '';
        ALTER TABLE shop_repair_jobs ADD COLUMN IF NOT EXISTS received_by_name VARCHAR(160) NOT NULL DEFAULT 'Shop team';
        ALTER TABLE shop_repair_jobs ADD COLUMN IF NOT EXISTS repair_cost_kes BIGINT NOT NULL DEFAULT 0;
        ALTER TABLE shop_repair_jobs ADD COLUMN IF NOT EXISTS payment_client_uuid UUID;
        ALTER TABLE shop_repair_jobs ADD COLUMN IF NOT EXISTS payment_total_kes BIGINT;
        ALTER TABLE shop_repair_jobs ADD COLUMN IF NOT EXISTS payment_method VARCHAR(16);
        ALTER TABLE shop_repair_jobs ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(24);
        ALTER TABLE shop_repair_jobs ADD COLUMN IF NOT EXISTS payment_receipt_id UUID REFERENCES receipts(id);
        ALTER TABLE shop_repair_jobs ADD COLUMN IF NOT EXISTS payment_receipt_no VARCHAR(80);
        ALTER TABLE shop_repair_jobs ADD COLUMN IF NOT EXISTS collected_at TIMESTAMPTZ;
        CREATE UNIQUE INDEX IF NOT EXISTS shop_repair_jobs_payment_client_uuid_idx ON shop_repair_jobs(tenant_id,payment_client_uuid) WHERE payment_client_uuid IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS shop_repair_jobs_payment_receipt_id_idx ON shop_repair_jobs(payment_receipt_id) WHERE payment_receipt_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS shop_repair_jobs_reference_idx ON shop_repair_jobs(reference) WHERE reference IS NOT NULL;
        CREATE INDEX IF NOT EXISTS shop_repair_jobs_customer_phone_idx ON shop_repair_jobs(customer_phone);
        CREATE TABLE IF NOT EXISTS shop_repair_events (
          id BIGSERIAL PRIMARY KEY, repair_id BIGINT NOT NULL REFERENCES shop_repair_jobs(id) ON DELETE CASCADE,
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
          actor_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
          actor_name VARCHAR(160) NOT NULL, event_type VARCHAR(40) NOT NULL,
          details TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS shop_repair_events_repair_idx ON shop_repair_events(repair_id,created_at DESC);
        ALTER TABLE shop_repair_jobs ALTER COLUMN customer_id TYPE TEXT;
        CREATE INDEX IF NOT EXISTS shop_repair_jobs_tenant_date_idx ON shop_repair_jobs(tenant_id, status, expected_pick_date DESC);
        CREATE INDEX IF NOT EXISTS shop_repair_jobs_store_date_idx ON shop_repair_jobs(store_id, received_date DESC);
      `).then(() => undefined).catch(err => { this.repairSchemaPromise = null; throw err; });
    }
    await this.repairSchemaPromise;
  }

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
