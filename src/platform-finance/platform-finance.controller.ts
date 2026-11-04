import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';

@Controller('api/v1/platform-finance')
@UseGuards(AuthGuard, RolesGuard)
@Roles('super_admin')
export class PlatformFinanceController {
  constructor(private db: DbService) {}

  @Get('summary')
  async summary() {
    const result = await this.db.pool.query(
      `SELECT
        COALESCE(SUM(amount_kes) FILTER (WHERE entry_type='subscription_revenue'),0)::bigint AS subscriptions_kes,
        COALESCE(SUM(amount_kes) FILTER (WHERE entry_type='receipt_fee_revenue'),0)::bigint AS receipt_fees_kes,
        COALESCE(SUM(amount_kes),0)::bigint AS total_kes,
        COUNT(*)::int AS entries
       FROM platform_financial_ledger`
    );
    const row = result.rows[0];
    return {
      subscriptionRevenueKes: Number(row.subscriptions_kes),
      receiptFeeRevenueKes: Number(row.receipt_fees_kes),
      totalPlatformRevenueKes: Number(row.total_kes),
      ledgerEntries: row.entries,
      excludesShopSales: true,
      bankSettlementVerified: false
    };
  }

  @Get('entries')
  async entries() {
    const result = await this.db.pool.query(
      `SELECT id, entry_type AS "entryType", amount_kes AS "amountKes",
              external_reference AS "externalReference", created_at AS "createdAt"
         FROM platform_financial_ledger
        ORDER BY created_at DESC, id DESC LIMIT 100`
    );
    return { entries: result.rows };
  }
}
