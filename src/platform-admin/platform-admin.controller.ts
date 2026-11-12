import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
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
}
