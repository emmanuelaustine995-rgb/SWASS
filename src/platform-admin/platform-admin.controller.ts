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
