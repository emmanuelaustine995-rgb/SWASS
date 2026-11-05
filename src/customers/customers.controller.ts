import { BadRequestException, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';

@Controller('api/v1/customers')
@UseGuards(AuthGuard, RolesGuard)
export class CustomersController {
  constructor(private db: DbService) {}

  @Get()
  @Roles('owner', 'manager', 'cashier')
  async list(@Req() req: any, @Query('q') q?: string, @Query('limit') limit?: string) {
    const { tenantId, storeId } = req.user ?? {};
    if (!tenantId || !storeId) throw new BadRequestException('User is not tied to a store');
    const search = String(q ?? '').trim().slice(0, 100);
    const n = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new BadRequestException('limit must be from 1 to 100');
    const { rows } = await this.db.pool.query(
      `SELECT c.id,c.full_name AS "fullName",c.phone,c.email,c.loyalty_points AS "loyaltyPoints",
              COUNT(DISTINCT r.id)::int AS "purchaseCount",
              COALESCE(SUM(r.total_kes) FILTER (WHERE r.status='issued'),0)::bigint AS "lifetimeSpendKes",
              MAX(r.issued_at) AS "lastPurchaseAt"
         FROM customers c
         LEFT JOIN receipts r ON r.customer_id=c.id AND r.tenant_id=c.tenant_id AND r.store_id=$2
        WHERE c.tenant_id=$1
          AND ($3='' OR c.full_name ILIKE '%'||$3||'%' OR c.phone ILIKE '%'||$3||'%' OR COALESCE(c.email,'') ILIKE '%'||$3||'%')
        GROUP BY c.id
        ORDER BY MAX(r.issued_at) DESC NULLS LAST,c.full_name ASC LIMIT $4`,
      [tenantId, storeId, search, n],
    );
    return { customers: rows.map((r:any)=>({...r,lifetimeSpendKes:Number(r.lifetimeSpendKes)})) };
  }
}
