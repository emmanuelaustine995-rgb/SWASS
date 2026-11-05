import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';
import { hashNationalId, normalisePhone } from '../receipts/receipts.service';

@Controller('api/v1/customers')
@UseGuards(AuthGuard, RolesGuard)
export class CustomersController {
  constructor(private db: DbService) {}

  @Post('lookup')
  @Roles('owner', 'manager', 'cashier')
  async lookup(@Req() req: any, @Body() body: { phone?: string; nationalId?: string }) {
    const { tenantId, storeId } = req.user ?? {};
    if (!tenantId || !storeId) throw new BadRequestException('User is not tied to a store');
    if (typeof body?.phone !== 'string' || typeof body?.nationalId !== 'string') {
      throw new BadRequestException('Enter both the customer phone number and National ID');
    }
    const phone = normalisePhone(body.phone);
    const nationalId = body.nationalId.trim();
    if (!/^[0-9A-Za-z-]{5,30}$/.test(nationalId)) throw new BadRequestException('Enter a valid National ID');
    const nationalIdHash = hashNationalId(nationalId);
    const { rows } = await this.db.pool.query(
      `SELECT c.id,c.full_name AS "fullName",c.phone,c.email,c.national_id_last4 AS "nationalIdLast4",
              c.loyalty_points AS "loyaltyPoints",
              COUNT(DISTINCT r.id) FILTER (WHERE r.status='issued')::int AS "purchaseCount",
              COALESCE(SUM(r.total_kes) FILTER (WHERE r.status='issued'),0)::bigint AS "lifetimeSpendKes",
              MAX(r.issued_at) AS "lastPurchaseAt"
         FROM customers c
         LEFT JOIN receipts r ON r.customer_id=c.id AND r.tenant_id=c.tenant_id AND r.store_id=$2
        WHERE c.tenant_id=$1 AND c.phone=$3 AND c.national_id_hash=$4
        GROUP BY c.id LIMIT 1`,
      [tenantId, storeId, phone, nationalIdHash],
    );
    if (!rows[0]) return { found: false, customer: null, recentReceipts: [] };
    const history = await this.db.pool.query(
      `SELECT r.id,r.receipt_no AS "receiptNo",r.issued_at AS "issuedAt",
              r.total_kes AS "totalKes",r.status,r.payment_method AS "paymentMethod",
              COALESCE(json_agg(json_build_object('name',ri.name,'qty',ri.qty,'lineTotalKes',ri.line_total_kes)
                ORDER BY ri.id) FILTER (WHERE ri.id IS NOT NULL),'[]'::json) AS items
         FROM receipts r LEFT JOIN receipt_items ri ON ri.receipt_id=r.id
        WHERE r.customer_id=$1 AND r.tenant_id=$2 AND r.store_id=$3
        GROUP BY r.id ORDER BY r.issued_at DESC LIMIT 10`,
      [rows[0].id, tenantId, storeId],
    );
    return {
      found: true,
      customer: { ...rows[0], lifetimeSpendKes: Number(rows[0].lifetimeSpendKes) },
      recentReceipts: history.rows.map((r:any)=>({...r,totalKes:Number(r.totalKes)})),
    };
  }

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
              COUNT(DISTINCT r.id) FILTER (WHERE r.status='issued')::int AS "purchaseCount",
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
