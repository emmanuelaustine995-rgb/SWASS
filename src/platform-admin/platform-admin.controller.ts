import { BadRequestException, Controller, Get, Param, Post, Query, UseGuards, NotFoundException, Req } from '@nestjs/common';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';

@Controller('api/v1/platform-admin')
@UseGuards(AuthGuard, RolesGuard)
@Roles('super_admin')
export class PlatformAdminController {
  constructor(private db: DbService) {}

  @Get('overview')
  async overview() {
    const [shops, stores, users, customers, receipts, subscriptions] = await Promise.all([
      this.db.pool.query('SELECT COUNT(*)::int AS count FROM tenants'),
      this.db.pool.query('SELECT COUNT(*)::int AS count FROM stores'),
      this.db.pool.query(`SELECT
        COUNT(*) FILTER (WHERE role='owner' AND is_active=true)::int AS owners,
        COUNT(*) FILTER (WHERE role='freelancer' AND is_active=true)::int AS freelancers,
        COUNT(*) FILTER (WHERE is_active=false)::int AS inactive
        FROM users`),
      this.db.pool.query('SELECT COUNT(*) FILTER (WHERE is_active=true)::int AS active FROM customer_accounts'),
      this.db.pool.query(`SELECT COUNT(*)::int AS count FROM receipts WHERE status='issued'`),
      this.db.pool.query(`SELECT
        COUNT(*) FILTER (WHERE status='active' AND ends_at>now())::int AS active,
        COUNT(*) FILTER (WHERE status<>'active' OR ends_at<=now())::int AS inactive
        FROM subscriptions`),
    ]);
    return {
      shops: Number(shops.rows[0].count),
      stores: Number(stores.rows[0].count),
      activeOwners: Number(users.rows[0].owners),
      activeFreelancers: Number(users.rows[0].freelancers),
      activeCustomers: Number(customers.rows[0].active),
      inactiveUsers: Number(users.rows[0].inactive),
      issuedReceipts: Number(receipts.rows[0].count),
      activeSubscriptions: Number(subscriptions.rows[0].active),
      inactiveSubscriptions: Number(subscriptions.rows[0].inactive),
    };
  }


  @Get('reports')
  async platformReports(@Query('from') from = '', @Query('to') to = '') {
    const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z'));
    const endDate = validDate(to) ? to : new Date().toISOString().slice(0, 10);
    const startDate = validDate(from) ? from : new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    if (startDate > endDate) throw new BadRequestException('The report start date must be on or before the end date.');
    const span = (Date.parse(endDate + 'T00:00:00Z') - Date.parse(startDate + 'T00:00:00Z')) / 86400000;
    if (span > 365) throw new BadRequestException('Choose a reporting period of 366 days or less.');
    const params = [startDate, endDate];
    const [shops, users, receipts, subscriptions, ledger, daily, paymentMethods, topShops] = await Promise.all([
      this.db.pool.query(`SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status='active')::int AS active,
        COUNT(*) FILTER (WHERE status='suspended')::int AS suspended,
        COUNT(*) FILTER (WHERE created_at >= $1::date AND created_at < $2::date + interval '1 day')::int AS new_in_period
        FROM tenants`),
      this.db.pool.query(`SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE is_active=true)::int AS active,
        COUNT(*) FILTER (WHERE is_active=false)::int AS inactive,
        COUNT(*) FILTER (WHERE created_at >= $1::date AND created_at < $2::date + interval '1 day')::int AS new_in_period
        FROM users WHERE role <> 'super_admin'`, params),
      this.db.pool.query(`SELECT COUNT(*) FILTER (WHERE status='issued')::int AS issued,
        COUNT(*) FILTER (WHERE status='voided')::int AS voided,
        COUNT(*) FILTER (WHERE status='returned')::int AS returned,
        COALESCE(SUM(total_kes) FILTER (WHERE status='issued'),0)::bigint AS issued_value_kes,
        COUNT(*) FILTER (WHERE issued_at >= $1::date AND issued_at < $2::date + interval '1 day' AND status='issued')::int AS issued_in_period,
        COALESCE(SUM(total_kes) FILTER (WHERE issued_at >= $1::date AND issued_at < $2::date + interval '1 day' AND status='issued'),0)::bigint AS issued_value_in_period_kes
        FROM receipts WHERE issued_at >= $1::date AND issued_at < $2::date + interval '1 day'`, params),
      this.db.pool.query(`SELECT COUNT(*) FILTER (WHERE starts_at >= $1::date AND starts_at < $2::date + interval '1 day')::int AS started_in_period,
        COUNT(*) FILTER (WHERE status='active' AND starts_at<=now() AND ends_at>now())::int AS active_now,
        COUNT(*) FILTER (WHERE ends_at >= $1::date AND ends_at < $2::date + interval '1 day')::int AS ending_in_period
        FROM subscriptions`, params),
      this.db.pool.query(`SELECT
        COALESCE(SUM(amount_kes) FILTER (WHERE entry_type='subscription_revenue'),0)::bigint AS subscription_kes,
        COALESCE(SUM(amount_kes) FILTER (WHERE entry_type='receipt_fee_revenue'),0)::bigint AS receipt_fee_kes,
        COALESCE(SUM(amount_kes),0)::bigint AS total_kes, COUNT(*)::int AS entries
        FROM platform_financial_ledger WHERE created_at >= $1::date AND created_at < $2::date + interval '1 day'`, params),
      this.db.pool.query(`WITH days AS (
          SELECT generate_series($1::date,$2::date,interval '1 day')::date AS day
        ), r AS (
          SELECT issued_at::date AS day, COUNT(*) FILTER (WHERE status='issued')::int AS receipts,
                 COALESCE(SUM(total_kes) FILTER (WHERE status='issued'),0)::bigint AS sales_kes
          FROM receipts WHERE issued_at >= $1::date AND issued_at < $2::date + interval '1 day' GROUP BY issued_at::date
        ), u AS (
          SELECT created_at::date AS day, COUNT(*)::int AS registrations
          FROM users WHERE role <> 'super_admin' AND created_at >= $1::date AND created_at < $2::date + interval '1 day' GROUP BY created_at::date
        ), t AS (
          SELECT created_at::date AS day, COUNT(*)::int AS new_shops
          FROM tenants WHERE created_at >= $1::date AND created_at < $2::date + interval '1 day' GROUP BY created_at::date
        )
        SELECT days.day, COALESCE(r.receipts,0)::int AS receipts, COALESCE(r.sales_kes,0)::bigint AS "salesKes",
               COALESCE(u.registrations,0)::int AS registrations, COALESCE(t.new_shops,0)::int AS "newShops"
        FROM days LEFT JOIN r USING(day) LEFT JOIN u USING(day) LEFT JOIN t USING(day) ORDER BY days.day`, params),
      this.db.pool.query(`SELECT payment_method AS "paymentMethod", COUNT(*) FILTER (WHERE status='issued')::int AS receipts,
        COALESCE(SUM(total_kes) FILTER (WHERE status='issued'),0)::bigint AS "salesKes"
        FROM receipts WHERE issued_at >= $1::date AND issued_at < $2::date + interval '1 day'
        GROUP BY payment_method ORDER BY payment_method`, params),
      this.db.pool.query(`SELECT t.name AS "businessName", COUNT(r.id) FILTER (WHERE r.status='issued')::int AS receipts,
        COALESCE(SUM(r.total_kes) FILTER (WHERE r.status='issued'),0)::bigint AS "salesKes"
        FROM tenants t LEFT JOIN receipts r ON r.tenant_id=t.id
          AND r.issued_at >= $1::date AND r.issued_at < $2::date + interval '1 day'
        GROUP BY t.id,t.name ORDER BY "salesKes" DESC, receipts DESC LIMIT 10`, params),
    ]);
    return {
      period: { from: startDate, to: endDate },
      shops: shops.rows[0], users: users.rows[0], receipts: receipts.rows[0],
      subscriptions: subscriptions.rows[0], platformRevenue: ledger.rows[0],
      daily: daily.rows, paymentMethods: paymentMethods.rows, topShops: topShops.rows,
      definitions: { shopSalesAreNotPlatformRevenue: true, receiptSalesAreGrossIssuedReceiptValue: true, platformRevenueIsLedgerOnly: true },
      generatedAt: new Date().toISOString(),
    };
  }

  @Get('shops')
  async shopDirectory(@Query('search') search = '', @Query('limit') limit = '50') {
    const term = String(search || '').trim().slice(0, 100);
    const take = Number(limit);
    if (!Number.isInteger(take) || take < 1 || take > 100) throw new BadRequestException('limit must be from 1 to 100');
    const result = await this.db.pool.query(
      `SELECT t.id AS "tenantId",t.name AS "businessName",t.phone AS "businessPhone",
              t.email AS "businessEmail",s.id AS "storeId",s.name AS "storeName",
              s.location AS "storeLocation",
              (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id=t.id AND u.is_active=true) AS "activeUsers",
              (SELECT COUNT(*)::int FROM receipts r WHERE r.tenant_id=t.id AND r.status='issued') AS "issuedReceipts",
              (SELECT sub.status FROM subscriptions sub WHERE sub.tenant_id=t.id ORDER BY sub.ends_at DESC LIMIT 1) AS "subscriptionStatus",
              (SELECT sub.ends_at FROM subscriptions sub WHERE sub.tenant_id=t.id ORDER BY sub.ends_at DESC LIMIT 1) AS "subscriptionEndsAt"
         FROM tenants t
         LEFT JOIN LATERAL (
           SELECT st.id,st.name,st.location FROM stores st WHERE st.tenant_id=t.id ORDER BY st.name LIMIT 1
         ) s ON true
        WHERE ($1='' OR t.name ILIKE '%'||$1||'%' OR COALESCE(t.phone,'') ILIKE '%'||$1||'%' OR COALESCE(t.email,'') ILIKE '%'||$1||'%')
        ORDER BY t.name ASC LIMIT $2`,
      [term, take],
    );
    return { shops: result.rows };
  }

  @Get('security/summary')
  async securitySummary() {
    await this.db.ensureSecuritySchema();
    const result = await this.db.pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= now()-interval '24 hours')::int AS events_24h,
        COUNT(*) FILTER (WHERE created_at >= now()-interval '24 hours' AND severity='critical')::int AS critical_24h,
        COUNT(*) FILTER (WHERE created_at >= now()-interval '24 hours' AND severity='high')::int AS high_24h,
        COUNT(*) FILTER (WHERE created_at >= now()-interval '24 hours' AND event_type IN ('login_failed','admin_login_failed'))::int AS failed_logins_24h,
        COUNT(DISTINCT source_ip) FILTER (WHERE created_at >= now()-interval '24 hours' AND outcome='blocked')::int AS blocked_sources_24h,
        COUNT(*) FILTER (WHERE created_at >= now()-interval '7 days' AND event_type='shop_deactivated')::int AS shops_deactivated_7d,
        COUNT(*) FILTER (WHERE created_at >= now()-interval '24 hours' AND event_type='admin_login_success')::int AS admin_logins_24h
      FROM aurora_security_events
    `);
    const open = await this.db.pool.query(`
      SELECT COUNT(*)::int AS count FROM aurora_security_events
       WHERE severity IN ('critical','high') AND outcome IN ('detected','blocked')
         AND created_at >= now()-interval '7 days'
    `);
    return { ...result.rows[0], openHighPriority: Number(open.rows[0].count), monitoring: 'event-log' };
  }

  @Get('security/events')
  async securityEvents(@Query('limit') limit = '50', @Query('severity') severity = '') {
    await this.db.ensureSecuritySchema();
    const take = Math.min(100, Math.max(1, Number.parseInt(String(limit), 10) || 50));
    const validSeverity = ['critical','high','medium','low','info'].includes(severity) ? severity : '';
    const result = await this.db.pool.query(`
      SELECT id,event_type AS "eventType",severity,outcome,actor_user_id AS "actorUserId",source_ip AS "sourceIp",
             user_agent AS "userAgent",metadata,created_at AS "createdAt"
        FROM aurora_security_events
       WHERE ($1='' OR severity=$1)
       ORDER BY created_at DESC LIMIT $2
    `, [validSeverity, take]);
    return { events: result.rows };
  }

  @Get('security/trends')
  async securityTrends() {
    await this.db.ensureSecuritySchema();
    const result = await this.db.pool.query(`
      SELECT to_char(date_trunc('hour', created_at), 'YYYY-MM-DD"T"HH24:00:00') AS hour,
             COUNT(*)::int AS events,
             COUNT(*) FILTER (WHERE severity IN ('critical','high'))::int AS high_priority,
             COUNT(*) FILTER (WHERE event_type IN ('login_failed','admin_login_failed'))::int AS failed_logins
        FROM aurora_security_events
       WHERE created_at >= now()-interval '24 hours'
       GROUP BY date_trunc('hour', created_at)
       ORDER BY date_trunc('hour', created_at)
    `);
    return { points: result.rows };
  }

  @Get('system/status')
  async systemStatus() {
    const checks: Array<{ key: string; label: string; status: 'ready' | 'attention' | 'unknown'; detail: string }> = [];
    const configured = (key: string, minLength = 1) => Boolean(process.env[key] && process.env[key]!.length >= minLength);
    checks.push({
      key: 'database-config', label: 'Database connection setting',
      status: configured('DATABASE_URL') ? 'ready' : 'attention',
      detail: configured('DATABASE_URL') ? 'Database connection string is present; its value is never exposed.' : 'DATABASE_URL is missing from the API environment.',
    });
    checks.push({
      key: 'jwt-secret', label: 'JWT signing secret',
      status: configured('JWT_SECRET', 32) ? 'ready' : 'attention',
      detail: configured('JWT_SECRET', 32) ? 'Signing secret is present and meets the 32-character minimum.' : 'Missing or shorter than the 32-character minimum.',
    });
    checks.push({
      key: 'id-secret', label: 'Identity encryption secret',
      status: configured('SWASS_ID_SECRET', 32) ? 'ready' : 'attention',
      detail: configured('SWASS_ID_SECRET', 32) ? 'Identity secret is present and meets the 32-character minimum.' : 'Missing or shorter than the 32-character minimum.',
    });
    let database = 'down';
    try {
      await this.db.pool.query('SELECT 1');
      database = 'connected';
    } catch {
      database = 'unavailable';
    }
    checks.push({
      key: 'database-live', label: 'Live database connectivity',
      status: database === 'connected' ? 'ready' : 'attention',
      detail: database === 'connected' ? 'The API completed a database health query.' : 'The API could not complete a database health query.',
    });
    let audit = 'unavailable';
    try {
      await this.db.ensureSecuritySchema();
      await this.db.pool.query('SELECT id FROM aurora_security_events ORDER BY id DESC LIMIT 1');
      audit = 'ready';
    } catch {
      audit = 'unavailable';
    }
    checks.push({
      key: 'security-audit', label: 'Security event storage',
      status: audit === 'ready' ? 'ready' : 'attention',
      detail: audit === 'ready' ? 'Security event table is available for recording and review.' : 'Security event storage could not be verified.',
    });
    return {
      environment: process.env.NODE_ENV || 'development',
      runtime: 'Node.js / NestJS',
      database,
      securityAudit: audit,
      checkedAt: new Date().toISOString(),
      checks,
      integrations: [
        { key: 'sms', label: 'SMS / OTP provider', status: 'not_verified', detail: 'Provider credentials and delivery are not tested by this status check. Verify them in the hosting environment and with a real test OTP.' },
        { key: 'payments', label: 'Payment gateway', status: 'not_verified', detail: 'Gateway credentials and live STK/payment callbacks are not tested here.' },
        { key: 'backups', label: 'Database backups', status: 'not_connected', detail: 'Backup schedule and restore tests are managed outside this application and are not connected to this portal.' },
      ],
    };
  }

  @Post('shops/:tenantId/deactivate')
  async deactivateShop(@Param('tenantId') tenantId: string, @Req() req: any) {
    const id = String(tenantId || '').trim();
    if (!id || id.length > 80) throw new BadRequestException('A valid shop identifier is required');
    const result = await this.db.pool.query(
      `UPDATE tenants SET status='suspended' WHERE id=$1 AND status='active'
       RETURNING id AS "tenantId", name AS "businessName", status`, [id],
    );
    if (!result.rowCount) {
      const existing = await this.db.pool.query('SELECT id,status FROM tenants WHERE id=$1 LIMIT 1', [id]);
      if (!existing.rowCount) throw new NotFoundException('Shop not found');
      return { deactivated: false, status: existing.rows[0].status, message: 'This shop is already inactive or suspended.' };
    }
    await this.db.recordSecurityEvent({
      eventType: 'shop_deactivated', severity: 'info', outcome: 'completed',
      actorUserId: req.user?.sub, sourceIp: req.ip, userAgent: req.headers?.['user-agent'],
      metadata: { tenantId: id, businessName: result.rows[0].businessName },
    });
    return { deactivated: true, shop: result.rows[0], message: 'Shop deactivated successfully.' };
  }

}
