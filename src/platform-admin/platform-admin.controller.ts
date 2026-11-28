import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, UseGuards, NotFoundException, Req } from '@nestjs/common';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';

@Controller('api/v1/platform-admin')
@UseGuards(AuthGuard, RolesGuard)
@Roles('super_admin')
export class PlatformAdminController {
  constructor(private db: DbService) {}

  @Get('passkeys')
  async listPasskeys() {
    const [summary, records] = await Promise.all([
      this.db.pool.query(`SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE last_used_at >= now()-interval '30 days')::int AS used_last_30_days
        FROM passkeys`),
      this.db.pool.query(`SELECT p.id,p.device_name,p.created_at,p.last_used_at,
          COALESCE(u.full_name,c.full_name,'Account') AS account_name,
          COALESCE(u.phone,c.phone,'') AS account_phone,
          COALESCE(u.role,'customer') AS account_role
        FROM passkeys p
        LEFT JOIN users u ON u.id=p.user_id
        LEFT JOIN customer_accounts c ON c.id=p.customer_id
        ORDER BY p.created_at DESC LIMIT 200`),
    ]);
    return { summary: summary.rows[0], items: records.rows };
  }

  @Delete('passkeys/:id')
  async revokePasskey(@Param('id') id: string, @Req() req: any) {
    if (!id || id.length > 512) throw new BadRequestException('Invalid passkey identifier.');
    const result = await this.db.pool.query(
      'DELETE FROM passkeys WHERE id=$1 RETURNING device_name,user_id,customer_id', [id],
    );
    if (!result.rowCount) throw new NotFoundException('Passkey not found.');
    await this.db.recordSecurityEvent({
      eventType: 'admin_passkey_revoked', severity: 'high', outcome: 'completed',
      actorUserId: req.user?.sub || null, sourceIp: req.ip, userAgent: req.headers?.['user-agent'],
      metadata: { deviceName: result.rows[0].device_name, affectedAccountId: result.rows[0].user_id || result.rows[0].customer_id },
    });
    return { ok: true, message: 'Passkey revoked. The device can no longer sign in with that credential.' };
  }


  @Get('operations/maintenance')
  async getMaintenance() {
    await this.db.ensureOperationsSchema();
    const result = await this.db.pool.query('SELECT maintenance_enabled AS enabled, maintenance_title AS title, maintenance_message AS message, maintenance_starts_at AS starts_at, updated_at AS updated_at FROM aurora_platform_operations WHERE id=1');
    return result.rows[0] || { enabled: false };
  }

  @Post('operations/maintenance')
  async setMaintenance(@Body() body: { enabled?: boolean; title?: string; message?: string }, @Req() req: any) {
    if (typeof body?.enabled !== 'boolean') throw new BadRequestException('Choose whether maintenance mode should be enabled or disabled.');
    const title = String(body.title || 'Scheduled maintenance').trim().slice(0,120);
    const message = String(body.message || '').trim();
    if (body.enabled && !message) throw new BadRequestException('Enter the maintenance message customers should see.');
    if (message.length > 600) throw new BadRequestException('Maintenance message must be 600 characters or fewer.');
    await this.db.ensureOperationsSchema();
    const result = await this.db.pool.query('UPDATE aurora_platform_operations SET maintenance_enabled=$1, maintenance_title=$2, maintenance_message=$3, maintenance_starts_at=CASE WHEN $1 THEN COALESCE(maintenance_starts_at,now()) ELSE NULL END, updated_by=$4, updated_at=now() WHERE id=1 RETURNING maintenance_enabled AS enabled, maintenance_title AS title, maintenance_message AS message, maintenance_starts_at AS starts_at, updated_at AS updated_at', [body.enabled,title,message || 'AURORA is temporarily unavailable while we improve our services. Please try again shortly.',req.user?.sub || null]);
    await this.db.recordSecurityEvent({ eventType: body.enabled ? 'maintenance_enabled' : 'maintenance_disabled', severity: body.enabled ? 'high' : 'medium', outcome: 'completed', actorUserId: req.user?.sub, sourceIp: req.ip, userAgent: req.headers?.['user-agent'], metadata: { title, message, enabled: body.enabled } });
    return { ...result.rows[0], message: body.enabled ? 'Maintenance mode is now active.' : 'Maintenance mode has been turned off.' };
  }

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
    const validDate = (value: string) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(value + 'T00:00:00Z'); return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value; };
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
        FROM tenants`, params),
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
              t.email AS "businessEmail",t.status AS "status",s.id AS "storeId",s.name AS "storeName",
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

  @Get('people')
  async peopleDirectory(@Query('search') search = '', @Query('limit') limit = '100') {
    const term = String(search || '').trim().slice(0, 100);
    const take = Number(limit);
    if (!Number.isInteger(take) || take < 1 || take > 200) throw new BadRequestException('limit must be from 1 to 200');
    const result = await this.db.pool.query(
      `SELECT u.id,u.full_name AS "fullName",u.phone,u.email,u.role,u.is_active AS "isActive",
              u.created_at AS "createdAt",t.name AS "businessName"
         FROM users u
         LEFT JOIN tenants t ON t.id=u.tenant_id
        WHERE u.role IN ('owner','manager','freelancer')
          AND ($1='' OR u.full_name ILIKE '%'||$1||'%' OR COALESCE(u.phone,'') ILIKE '%'||$1||'%' OR COALESCE(u.email,'') ILIKE '%'||$1||'%' OR COALESCE(t.name,'') ILIKE '%'||$1||'%')
        ORDER BY u.created_at DESC LIMIT $2`,
      [term, take],
    );
    return { people: result.rows };
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

  @Get('security/lost-phones')
  async securityLostPhones(@Query('limit') limit = '100') {
    const take = Math.min(200, Math.max(1, Number.parseInt(String(limit), 10) || 100));
    const result = await this.db.pool.query(`
      SELECT li.id,li.item_code AS "itemCode",li.item_name AS "itemName",li.brand,li.model,li.colour,
             li.description,li.imei_1 AS "imei1",li.imei_2 AS "imei2",li.serial_number AS "serialNumber",
             li.ob_number AS "obNumber",li.status,li.lost_at AS "lostAt",li.recovered_at AS "recoveredAt",
             li.created_at AS "createdAt",t.id AS "tenantId",t.name AS "shopName",t.phone AS "shopPhone",
             t.email AS "shopEmail",s.name AS "branchName",s.location AS "branchLocation",
             u.full_name AS "registeredBy",u.phone AS "registeredByPhone",
             COALESCE(report_data.report_count,0)::int AS "reportCount",
             COALESCE(report_data.reports,'[]'::json) AS reports,
             last_search.identifier AS "lastSearchedIdentifier",
             last_search.searched_by_name AS "lastSearchedBy",
             last_search.searched_by_phone AS "lastSearchedByPhone",
             last_search.searched_at AS "lastSearchedAt"
        FROM lost_items li
        JOIN tenants t ON t.id=li.tenant_id
        LEFT JOIN stores s ON s.id=li.store_id AND s.tenant_id=li.tenant_id
        LEFT JOIN users u ON u.id=li.registered_by
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS report_count,
                 json_agg(json_build_object(
                   'reporterName',r.reporter_name,'reporterPhone',r.reporter_phone,
                   'details',r.report_details,'locationLabel',r.location_label,
                   'latitude',r.latitude,'longitude',r.longitude,'accuracy',r.accuracy_m,
                   'createdAt',r.created_at
                 ) ORDER BY r.created_at DESC) AS reports
            FROM lost_item_reports r WHERE r.lost_item_id=li.id
        ) report_data ON TRUE
        LEFT JOIN LATERAL (
          SELECT searched_by_name, searched_by_phone, identifier, searched_at
            FROM lost_item_searches WHERE item_code=li.item_code
           ORDER BY searched_at DESC LIMIT 1
        ) last_search ON TRUE
       WHERE li.status IN ('lost','found','recovered')
       ORDER BY COALESCE(li.lost_at,li.created_at) DESC
       LIMIT $1
    `, [take]);
    return { phones: result.rows, visibility: 'super_admin_only' };
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

  @Post('shops/:tenantId/restore')
  async restoreSuspendedShop(@Param('tenantId') tenantId: string, @Req() req: any) {
    const id = String(tenantId || '').trim();
    if (!id || id.length > 80) throw new BadRequestException('A valid shop identifier is required');
    const result = await this.db.pool.query(
      `UPDATE tenants SET status='active' WHERE id=$1 AND status='suspended'
       RETURNING id AS "tenantId",name AS "businessName",status`, [id],
    );
    if (!result.rowCount) {
      const existing = await this.db.pool.query('SELECT id,status FROM tenants WHERE id=$1 LIMIT 1', [id]);
      if (!existing.rowCount) throw new NotFoundException('Shop not found');
      throw new BadRequestException(existing.rows[0].status === 'closed'
        ? 'Archived shops cannot be restored from this action.'
        : 'Only suspended shops can be restored.');
    }
    await this.db.recordSecurityEvent({
      eventType: 'shop_reactivated', severity: 'high', outcome: 'completed',
      actorUserId: req.user?.sub, sourceIp: req.ip, userAgent: req.headers?.['user-agent'],
      metadata: { tenantId: id, businessName: result.rows[0].businessName },
    });
    return { restored: true, shop: result.rows[0], message: 'Shop access restored. Subscription status remains unchanged.' };
  }

  @Post('people/:userId/status')
  async setPersonAccountStatus(
    @Param('userId') userId: string,
    @Body() body: { active?: boolean },
    @Req() req: any,
  ) {
    const id = String(userId || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new BadRequestException('A valid account identifier is required.');
    }
    if (typeof body?.active !== 'boolean') throw new BadRequestException('Choose whether the account should be active.');
    if (id === String(req.user?.sub || '')) throw new BadRequestException('You cannot deactivate your own signed-in account.');
    const result = await this.db.pool.query(
      `UPDATE users
          SET is_active=$2
        WHERE id=$1 AND role IN ('owner','manager','freelancer')
        RETURNING id,full_name AS "fullName",role,is_active AS "isActive"`,
      [id, body.active],
    );
    if (!result.rowCount) throw new NotFoundException('Eligible shop-owner, manager or freelancer account not found.');
    await this.db.recordSecurityEvent({
      eventType: body.active ? 'user_account_reactivated' : 'user_account_deactivated',
      severity: body.active ? 'medium' : 'high', outcome: 'completed',
      actorUserId: req.user?.sub, sourceIp: req.ip, userAgent: req.headers?.['user-agent'],
      metadata: { targetUserId: id, role: result.rows[0].role, active: body.active },
    });
    return {
      updated: true, person: result.rows[0],
      message: body.active ? 'Account access restored.' : 'Account deactivated. The account can no longer sign in.',
    };
  }

  @Post('shops/:tenantId/delete')
  async deleteDeactivatedShop(@Param('tenantId') tenantId: string, @Req() req: any) {
    const id = String(tenantId || '').trim();
    if (!id || id.length > 80) throw new BadRequestException('A valid shop identifier is required');
    const result = await this.db.pool.query(
      `UPDATE tenants SET status='closed'
        WHERE id=$1 AND status='suspended'
        RETURNING id AS "tenantId",name AS "businessName",status`,
      [id],
    );
    if (!result.rowCount) {
      const existing = await this.db.pool.query('SELECT id,status FROM tenants WHERE id=$1 LIMIT 1', [id]);
      if (!existing.rowCount) throw new NotFoundException('Shop not found');
      if (existing.rows[0].status === 'closed') {
        return { deleted: false, archived: true, message: 'This shop has already been deleted from the active directory.' };
      }
      throw new BadRequestException('Deactivate this shop before deleting it.');
    }
    await this.db.recordSecurityEvent({
      eventType: 'shop_deleted', severity: 'high', outcome: 'completed',
      actorUserId: req.user?.sub, sourceIp: req.ip, userAgent: req.headers?.['user-agent'],
      metadata: { tenantId: id, businessName: result.rows[0].businessName, deletionMode: 'soft_delete_preserve_history' },
    });
    return {
      deleted: true, archived: true, shop: result.rows[0],
      message: 'Shop removed from the active shop directory. Receipts, sales, payments and audit history are preserved for records.',
    };
  }

  @Post('accounts/reset')
  async resetRegisteredAccounts(@Req() req: any) {
    await this.db.ensureSecuritySchema();
    const result = await this.db.tx(async client => {
      const users = await client.query(
        `UPDATE users
            SET is_active=false, national_id_number=NULL, national_id_photo_data=NULL
          WHERE role <> 'super_admin'
            AND NOT EXISTS (
              SELECT 1 FROM aurora_admin_identity_records admin_record
               WHERE admin_record.user_id = users.id
            )
          RETURNING id`,
      );
      const userIds = users.rows.map((row: { id: string }) => row.id);
      if (userIds.length) {
        await client.query('DELETE FROM aurora_owner_identity_records WHERE user_id = ANY($1::uuid[])', [userIds]);
      }
      const customers = await client.query(
        `UPDATE customer_accounts SET is_active=false
          WHERE is_active=true RETURNING id`,
      );
      const subscriptions = await client.query(
        `UPDATE subscriptions
            SET status='expired', auto_renew=false,
                ends_at=GREATEST(now(), starts_at + interval '1 second')
          WHERE status='active'
          RETURNING id`,
      );
      const ownerOtps = await client.query(
        `UPDATE signup_otp_requests SET expires_at=now()
          WHERE expires_at>now() RETURNING id`,
      );
      const customerOtps = await client.query(
        `UPDATE customer_signup_otp_requests SET expires_at=now()
          WHERE expires_at>now() RETURNING id`,
      );
      return {
        deactivatedUserAccounts: users.rowCount || 0,
        deactivatedCustomerAccounts: customers.rowCount || 0,
        expiredSubscriptions: subscriptions.rowCount || 0,
        expiredPendingOwnerRegistrations: ownerOtps.rowCount || 0,
        expiredPendingCustomerRegistrations: customerOtps.rowCount || 0,
      };
    });
    // The reset transaction is the source of truth. Audit logging must not
    // turn a successfully committed reset into a misleading HTTP failure.
    try {
      await this.db.recordSecurityEvent({
        eventType: 'registered_accounts_reset',
        severity: 'high',
        outcome: 'completed',
        actorUserId: req.user?.sub,
        sourceIp: req.ip,
        userAgent: req.headers?.['user-agent'],
        metadata: result,
      });
    } catch (error) {
      console.error('[AURORA_ADMIN] Account reset committed, but audit logging failed:', error instanceof Error ? error.message : error);
    }
    return {
      reset: true,
      ...result,
      preserved: ['super_admin accounts', 'businesses and stores', 'receipts and sales history', 'customers and inventory', 'financial ledger and payment history'],
      message: 'Non-admin login accounts have been deactivated and subscriptions expired. Historical business records remain preserved; previous users can register again using their details.',
    };
  }


  // Super Admin reconciliation queue: only subscription payments that the
  // gateway has not completed are shown. Never expose credentials or secrets.
  @Get('subscription-payments')
  async subscriptionPaymentQueue(@Query('limit') limit = '100') {
    await this.db.ensureFreelancerSubscriptionSchema();
    const take = Math.min(200, Math.max(1, Number.parseInt(String(limit), 10) || 100));
    const result = await this.db.pool.query(
      `SELECT p.id,p.tenant_id AS "tenantId",p.subscriber_user_id AS "subscriberUserId",
              p.amount_kes AS "amountKes",p.phone,p.status,p.checkout_request_id AS "checkoutRequestId",
              p.mpesa_receipt_no AS "receiptNumber",p.created_at AS "createdAt",
              claim.receipt_number AS "claimedReceiptNumber",claim.status AS "claimStatus",claim.created_at AS "claimCreatedAt",
              t.name AS "businessName",u.full_name AS "subscriberName",u.email AS "subscriberEmail"
         FROM payments p
         LEFT JOIN tenants t ON t.id=p.tenant_id
         LEFT JOIN users u ON u.id=p.subscriber_user_id
         LEFT JOIN subscription_payment_receipt_claims claim ON claim.payment_id=p.id
        WHERE p.purpose='subscription' AND p.status IN ('pending','failed')
        ORDER BY p.created_at DESC LIMIT $1`,
      [take],
    );
    return { payments: result.rows.map((p:any)=>({...p,amountKes:Number(p.amountKes)})) };
  }

  // Manual recovery is allowed only after the administrator independently
  // verifies the M-Pesa/Tuma transaction. Amount, payer phone and unique
  // provider receipt are checked and the full action is written to audit log.
  @Post('subscription-payments/:paymentId/reconcile')
  async reconcileSubscriptionPayment(
    @Param('paymentId') paymentId: string,
    @Body() body: { receiptNumber?: string; amountKes?: number; phone?: string; verifiedExternally?: boolean; note?: string },
    @Req() req: any,
  ) {
    const id = String(paymentId || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new BadRequestException('A valid payment identifier is required.');
    }
    const receipt = String(body?.receiptNumber || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6,24}$/.test(receipt)) throw new BadRequestException('Enter the exact M-Pesa/Tuma transaction receipt reference.');
    if (body?.verifiedExternally !== true) throw new BadRequestException('Confirm that you verified this payment in the payment provider transaction records.');
    const amount = Number(body?.amountKes);
    if (!Number.isSafeInteger(amount) || ![100,900].includes(amount)) throw new BadRequestException('Subscription amount must be exactly KSh 100 or KSh 900.');
    const normalizePhone = (value:string) => String(value || '').replace(/\\D/g,'').replace(/^254/,'0');
    const confirmedPhone = normalizePhone(String(body?.phone || ''));
    if (!/^0[17]\\d{8}$/.test(confirmedPhone)) throw new BadRequestException('Enter the payer phone number shown in the provider transaction record.');
    const note = String(body?.note || '').trim().slice(0,500);

    await this.db.ensureFreelancerSubscriptionSchema();
    const reconciled = await this.db.tx(async c => {
      const found = await c.query(
        `SELECT p.*,t.name AS business_name,u.full_name AS subscriber_name
           FROM payments p
           LEFT JOIN tenants t ON t.id=p.tenant_id
           LEFT JOIN users u ON u.id=p.subscriber_user_id
          WHERE p.id=$1 AND p.purpose='subscription'
          FOR UPDATE OF p`,
        [id],
      );
      if (!found.rowCount) throw new NotFoundException('Subscription payment was not found.');
      const p = found.rows[0];
      if (p.status === 'success') throw new BadRequestException('This payment is already marked successful. Refresh the customer subscription before taking another action.');
      if (!['pending','failed'].includes(p.status)) throw new BadRequestException('Only pending or failed subscription payments can be reconciled.');
      if (Number(p.amount_kes) !== amount) throw new BadRequestException('The confirmed amount does not match the original payment request.');
      if (normalizePhone(p.phone) !== confirmedPhone) throw new BadRequestException('The confirmed payer phone does not match the original payment request.');
      const duplicate = await c.query('SELECT id FROM payments WHERE mpesa_receipt_no=$1 AND id<>$2 LIMIT 1', [receipt,id]);
      if (duplicate.rowCount) throw new BadRequestException('That provider receipt reference is already linked to another payment.');

      const saved = await c.query(
        `UPDATE payments SET status='success',mpesa_receipt_no=$1
          WHERE id=$2 AND status IN ('pending','failed')
          RETURNING id,tenant_id,subscriber_user_id,amount_kes,phone,status,mpesa_receipt_no`,
        [receipt,id],
      );
      if (!saved.rowCount) throw new BadRequestException('Payment status changed while reconciliation was in progress. Refresh and try again.');

      await c.query(
        `INSERT INTO platform_financial_ledger(tenant_id,payment_id,entry_type,amount_kes,external_reference)
         VALUES($1,$2,'subscription_revenue',$3,$4)
         ON CONFLICT DO NOTHING`,
        [p.tenant_id,id,p.amount_kes,receipt],
      );
      await c.query(`UPDATE subscription_payment_receipt_claims SET status='verified' WHERE payment_id=$1`, [id]);
      const plan = Number(p.amount_kes) === 900 ? 'yearly' : 'monthly';
      const interval = plan === 'yearly' ? '1 year' : '1 month';
      if (p.subscriber_user_id) {
        await c.query(
          `INSERT INTO freelancer_subscriptions(user_id,payment_id,plan,price_kes,starts_at,ends_at,status)
           VALUES($1,$2,$3,$4,
             COALESCE((SELECT MAX(ends_at) FROM freelancer_subscriptions WHERE user_id=$1 AND status='active' AND ends_at>now()),now()),
             COALESCE((SELECT MAX(ends_at) FROM freelancer_subscriptions WHERE user_id=$1 AND status='active' AND ends_at>now()),now())+$5::interval,
             'active')
           ON CONFLICT(payment_id) DO NOTHING`,
          [p.subscriber_user_id,id,plan,p.amount_kes,interval],
        );
      } else {
        await c.query(
          `INSERT INTO subscriptions(tenant_id,plan,price_kes,starts_at,ends_at,status,auto_renew)
           VALUES($1,$2,$3,
             COALESCE((SELECT MAX(ends_at) FROM subscriptions WHERE tenant_id=$1 AND status='active' AND ends_at>now()),now()),
             COALESCE((SELECT MAX(ends_at) FROM subscriptions WHERE tenant_id=$1 AND status='active' AND ends_at>now()),now())+$4::interval,
             'active',false)`,
          [p.tenant_id,plan,p.amount_kes,interval],
        );
      }
      return {
        paymentId:id,tenantId:p.tenant_id,subscriberUserId:p.subscriber_user_id || null,
        businessName:p.business_name || null,subscriberName:p.subscriber_name || null,
        amountKes:Number(p.amount_kes),plan,receiptNumber:receipt,
      };
    });

    await this.db.recordSecurityEvent({
      eventType:'subscription_payment_manually_reconciled',severity:'high',outcome:'completed',
      actorUserId:req.user?.sub,sourceIp:req.ip,userAgent:req.headers?.['user-agent'],
      metadata:{...reconciled,verifiedExternally:true,note},
    });
    return {
      reconciled:true,payment:reconciled,
      message:'Payment reconciled and subscription activated. Ask the customer to refresh or sign in again to see the updated subscription.',
    };
  }

}
