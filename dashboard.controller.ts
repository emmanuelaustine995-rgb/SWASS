import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';

@Controller('api/v1/dashboard')
@UseGuards(AuthGuard, RolesGuard)
export class DashboardController {
  constructor(private db: DbService) {}

  private scope(user: any) {
    if (!user?.tenantId || !user?.storeId) throw new BadRequestException('User is not tied to a store');
    return [user.tenantId, user.storeId];
  }

  @Get('summary')
  @Roles('owner', 'manager')
  async summary(@Req() req: any, @Query('from') from?: string, @Query('to') to?: string) {
    const [tenantId, storeId] = this.scope(req.user);
    const start = this.dateParam(from, 'from');
    const end = this.dateParam(to, 'to');
    if (start && end && start >= end) throw new BadRequestException('from must be earlier than to');
    const startAt = start ?? new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const endAt = end ?? new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const params = [tenantId, storeId, startAt, endAt];

    const [sales, inventory, expenses, cashiers, subscription] = await Promise.all([
      this.db.pool.query(
        `SELECT COUNT(*)::int AS transactions,
                COALESCE(SUM(total_kes),0)::bigint AS sales_kes,
                COALESCE(SUM(discount_kes),0)::bigint AS discounts_kes
           FROM receipts WHERE tenant_id=$1 AND store_id=$2 AND status='issued'
             AND issued_at >= $3::date AND issued_at < $4::date`, params),
      this.db.pool.query(
        `SELECT COUNT(*) FILTER (WHERE stock_qty <= reorder_level)::int AS low_stock_count,
                COUNT(*)::int AS product_count,
                COALESCE(SUM(stock_qty * COALESCE(cost_kes,0)),0)::bigint AS stock_cost_kes,
                COALESCE(SUM(stock_qty * price_kes),0)::bigint AS stock_retail_kes
           FROM products WHERE tenant_id=$1 AND store_id=$2`, [tenantId, storeId]),
      this.db.pool.query(
        `SELECT COALESCE(SUM(amount_kes),0)::bigint AS expenses_kes, COUNT(*)::int AS expense_count
           FROM business_expenses WHERE tenant_id=$1 AND store_id=$2
             AND spent_at >= $3::date AND spent_at < $4::date`, params),
      this.db.pool.query(
        `SELECT u.full_name AS name, COUNT(r.id)::int AS transactions,
                COALESCE(SUM(r.total_kes),0)::bigint AS sales_kes
           FROM users u LEFT JOIN receipts r ON r.cashier_id=u.id AND r.tenant_id=$1 AND r.store_id=$2
             AND r.status='issued' AND r.issued_at >= $3::date AND r.issued_at < $4::date
          WHERE u.tenant_id=$1 AND u.store_id=$2 AND u.role='cashier'
          GROUP BY u.id,u.full_name ORDER BY SUM(r.total_kes) DESC NULLS LAST LIMIT 10`, params),
      this.db.pool.query(
        `SELECT s.plan, s.status, s.starts_at, s.ends_at, s.auto_renew,
                w.balance_kes, w.low_balance_alert_kes
           FROM subscriptions s LEFT JOIN wallets w ON w.tenant_id=s.tenant_id
          WHERE s.tenant_id=$1 ORDER BY s.ends_at DESC LIMIT 1`, [tenantId]),
    ]);
    const [costs, daily] = await Promise.all([
      this.db.pool.query(
        `SELECT COALESCE(SUM(ri.qty * ri.unit_cost_kes),0)::bigint AS cost_kes
           FROM receipt_items ri JOIN receipts r ON r.id=ri.receipt_id
          WHERE r.tenant_id=$1 AND r.store_id=$2 AND r.status='issued'
            AND r.issued_at >= $3::date AND r.issued_at < $4::date`, params),
      this.db.pool.query(
        `SELECT d.day::date AS day, COALESCE(SUM(r.total_kes),0)::bigint AS sales_kes,
                COUNT(r.id)::int AS transactions
           FROM generate_series($3::date, ($4::date - interval '1 day'), interval '1 day') d(day)
           LEFT JOIN receipts r ON r.tenant_id=$1 AND r.store_id=$2 AND r.status='issued'
             AND r.issued_at >= d.day AND r.issued_at < d.day + interval '1 day'
          GROUP BY d.day ORDER BY d.day`, params),
    ]);
    const sale = sales.rows[0], stock = inventory.rows[0], expense = expenses.rows[0];
    const salesKes = Number(sale.sales_kes), costKes = Number(costs.rows[0].cost_kes), expensesKes = Number(expense.expenses_kes);
    return {
      period: { from: startAt, toExclusive: endAt },
      sales: { transactions: sale.transactions, salesKes, discountsKes: Number(sale.discounts_kes), costOfGoodsKes: costKes, grossProfitKes: salesKes - costKes, expensesKes, estimatedNetOperatingKes: salesKes - costKes - expensesKes },
      inventory: { productCount: stock.product_count, lowStockCount: stock.low_stock_count, stockCostKes: Number(stock.stock_cost_kes), stockRetailKes: Number(stock.stock_retail_kes) },
      expenses: { count: expense.expense_count, totalKes: expensesKes },
      daily: daily.rows.map((r: any) => ({ day: new Date(r.day).toISOString().slice(0,10), salesKes: Number(r.sales_kes), transactions: r.transactions })),
      cashiers: cashiers.rows.map((r: any) => ({ name: r.name, transactions: r.transactions, salesKes: Number(r.sales_kes) })),
      subscription: subscription.rows[0] ? { ...subscription.rows[0], balanceKes: Number(subscription.rows[0].balance_kes ?? 0), lowBalanceAlertKes: Number(subscription.rows[0].low_balance_alert_kes ?? 0) } : null,
    };
  }

  @Get('expenses')
  @Roles('owner', 'manager')
  async listExpenses(@Req() req: any, @Query('limit') limit?: string) {
    const [tenantId, storeId] = this.scope(req.user);
    const n = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 200) throw new BadRequestException('limit must be from 1 to 200');
    const { rows } = await this.db.pool.query(
      `SELECT id, amount_kes AS "amountKes", category, note, spent_at AS "spentAt"
         FROM business_expenses WHERE tenant_id=$1 AND store_id=$2
        ORDER BY spent_at DESC LIMIT $3`, [tenantId, storeId, n]);
    return { expenses: rows };
  }

  @Post('expenses')
  @Roles('owner', 'manager')
  async addExpense(@Req() req: any, @Body() body: { amountKes?: number; category?: string; note?: string; spentAt?: string }) {
    const [tenantId, storeId] = this.scope(req.user);
    if (!Number.isSafeInteger(body?.amountKes) || body.amountKes! <= 0 || body.amountKes! > 100000000000) throw new BadRequestException('amountKes must be a positive whole number in Kenya shillings');
    if (typeof body.category !== 'string' || !body.category.trim() || body.category.trim().length > 80) throw new BadRequestException('Enter an expense category of up to 80 characters');
    if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 240)) throw new BadRequestException('note must be at most 240 characters');
    let spentAt: Date | undefined;
    if (body.spentAt !== undefined) { spentAt = new Date(body.spentAt); if (Number.isNaN(spentAt.getTime())) throw new BadRequestException('spentAt must be a valid date'); }
    const { rows } = await this.db.pool.query(
      `INSERT INTO business_expenses (tenant_id,store_id,recorded_by,amount_kes,category,note,spent_at)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,now()))
       RETURNING id, amount_kes AS "amountKes", category, note, spent_at AS "spentAt"`,
      [tenantId, storeId, req.user.sub, body.amountKes, body.category.trim(), body.note?.trim() || null, spentAt?.toISOString() ?? null]);
    return { expense: rows[0] };
  }

  private dateParam(value: string | undefined, name: string): string | null {
    if (value === undefined) return null;
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new BadRequestException(`${name} must be a real date in YYYY-MM-DD format`);
    return value;
  }
}
