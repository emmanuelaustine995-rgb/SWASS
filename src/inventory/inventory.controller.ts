import { BadRequestException, ConflictException, Controller, Get, Body, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type ProductInput = { name?: string; sku?: string | null; barcode?: string | null; priceKes?: number; costKes?: number | null; stockQty?: number; reorderLevel?: number; requiresBuyerId?: boolean };

@Controller('api/v1/products')
@UseGuards(AuthGuard, RolesGuard)
export class InventoryController {
  constructor(private db: DbService) {}

  @Get()
  @Roles('cashier', 'manager', 'owner')
  async list(@Req() req: any, @Query('q') q?: string, @Query('lowStock') lowStock?: string) {
    const user = req.user; this.requireStore(user);
    const search = typeof q === 'string' ? q.trim().slice(0, 100) : '';
    const { rows } = await this.db.pool.query(
      `SELECT id, sku, barcode, name, price_kes AS "priceKes", cost_kes AS "costKes", stock_qty AS "stockQty", reorder_level AS "reorderLevel", requires_buyer_id AS "requiresBuyerId"
         FROM products WHERE tenant_id = $1 AND store_id = $2
          AND archived_at IS NULL
          AND ($3 = '' OR name ILIKE '%' || $3 || '%' OR sku ILIKE '%' || $3 || '%' OR barcode ILIKE '%' || $3 || '%')
          AND (NOT $4 OR stock_qty <= reorder_level) ORDER BY name ASC LIMIT 500`,
      [user.tenantId, user.storeId, search, lowStock === 'true'],
    );
    return { products: rows };
  }

  @Post()
  @Roles('cashier', 'manager', 'owner')
  async create(@Req() req: any, @Body() body: ProductInput) {
    const user = req.user; this.requireStore(user); const d = this.validate(body, true);
    try {
      return await this.db.tx(async c => {
        const { rows } = await c.query(
          `INSERT INTO products (tenant_id, store_id, name, sku, barcode, price_kes, cost_kes, stock_qty, reorder_level, requires_buyer_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING id, sku, barcode, name, price_kes AS "priceKes", cost_kes AS "costKes", stock_qty AS "stockQty", reorder_level AS "reorderLevel", requires_buyer_id AS "requiresBuyerId"`,
          [user.tenantId, user.storeId, d.name, d.sku, d.barcode, d.priceKes, d.costKes, d.stockQty, d.reorderLevel, d.requiresBuyerId],
        );
        if (d.stockQty > 0) await c.query(`INSERT INTO stock_movements (product_id, change_qty, reason, user_id) VALUES ($1,$2,'restock',$3)`, [rows[0].id, d.stockQty, user.sub]);
        return { product: rows[0] };
      });
    } catch (e: any) { if (e?.code === '23505') throw new ConflictException('That barcode is already in use in this store'); throw e; }
  }

  @Post('archive-all')
  @Roles('manager', 'owner')
  async archiveAll(@Req() req: any) {
    const user = req.user; this.requireStore(user);
    return this.db.tx(async c => {
      const { rows } = await c.query(
        `UPDATE products p SET archived_at = now()
          WHERE p.tenant_id = $1 AND p.store_id = $2 AND p.archived_at IS NULL
          RETURNING p.id`,
        [user.tenantId, user.storeId],
      );
      return { archivedCount: rows.length, message: 'Current catalogue cleared. Previous receipts and sales remain unchanged.' };
    });
  }

  @Patch(':id')
  @Roles('manager', 'owner')
  async update(@Req() req: any, @Param('id') id: string, @Body() body: ProductInput) {
    const user = req.user; this.requireStore(user);
    if (!UUID.test(id)) throw new BadRequestException('Invalid product ID');
    const d = this.validate(body, false);
    const columns: Record<string, string> = { name: 'name', sku: 'sku', barcode: 'barcode', priceKes: 'price_kes', costKes: 'cost_kes', reorderLevel: 'reorder_level', requiresBuyerId: 'requires_buyer_id' };
    const entries = Object.entries(d).filter(([k, v]) => k !== 'stockQty' && v !== undefined);
    if (!entries.length) throw new BadRequestException('Provide at least one product field to update');
    const setSql = entries.map(([key], i) => `${columns[key]} = $${i + 4}`).join(', ');
    try {
      const { rows } = await this.db.pool.query(
        `UPDATE products SET ${setSql} WHERE id = $1 AND tenant_id = $2 AND store_id = $3
         RETURNING id, sku, barcode, name, price_kes AS "priceKes", cost_kes AS "costKes", stock_qty AS "stockQty", reorder_level AS "reorderLevel", requires_buyer_id AS "requiresBuyerId"`,
        [id, user.tenantId, user.storeId, ...entries.map(([, v]) => v)],
      );
      if (!rows[0]) throw new BadRequestException('Product not found in this business');
      return { product: rows[0] };
    } catch (e: any) { if (e?.code === '23505') throw new ConflictException('That barcode is already in use in this store'); throw e; }
  }

  @Post(':id/stock-adjustments')
  @Roles('manager', 'owner')
  async adjustStock(@Req() req: any, @Param('id') id: string, @Body() body: { changeQty?: number; note?: string }) {
    const user = req.user; this.requireStore(user);
    if (!UUID.test(id)) throw new BadRequestException('Invalid product ID');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('A stock adjustment object is required');
    if (!Number.isSafeInteger(body.changeQty) || body.changeQty === 0 || Math.abs(body.changeQty!) > 1000000) throw new BadRequestException('changeQty must be a non-zero whole number within 1,000,000');
    if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 200)) throw new BadRequestException('note must be at most 200 characters');
    return this.db.tx(async c => {
      const { rows } = await c.query(
        `UPDATE products SET stock_qty = stock_qty + $1 WHERE id = $2 AND tenant_id = $3 AND store_id = $4 RETURNING id, name, stock_qty AS "stockQty"`,
        [body.changeQty, id, user.tenantId, user.storeId],
      );
      if (!rows[0]) throw new BadRequestException('Product not found in this store');
      await c.query(`INSERT INTO stock_movements (product_id, change_qty, reason, user_id, note) VALUES ($1,$2,'adjustment',$3,$4)`, [id, body.changeQty, user.sub, body.note ?? null]);
      return { product: rows[0], adjustment: { changeQty: body.changeQty, note: body.note ?? null } };
    });
  }

  private requireStore(user: any) { if (!user?.tenantId || !user?.storeId) throw new BadRequestException('User is not tied to a store'); }

  private validate(body: ProductInput, creating: boolean) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('A product object is required');
    const d: any = {};
    if (body.name !== undefined || creating) {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 160) throw new BadRequestException('Product name is required and must be at most 160 characters');
      d.name = body.name.trim();
    }
    for (const key of ['sku', 'barcode'] as const) if (body[key] !== undefined) {
      if (body[key] !== null && (typeof body[key] !== 'string' || body[key].trim().length > 80)) throw new BadRequestException(`${key} must be at most 80 characters`);
      d[key] = body[key]?.trim() || null;
    }
    if (body.priceKes !== undefined || creating) {
      if (!Number.isSafeInteger(body.priceKes) || body.priceKes! < 0) throw new BadRequestException('priceKes must be a non-negative whole number');
      d.priceKes = body.priceKes;
    }
    if (body.costKes !== undefined) {
      if (body.costKes !== null && (!Number.isSafeInteger(body.costKes) || body.costKes < 0)) throw new BadRequestException('costKes must be null or a non-negative whole number');
      d.costKes = body.costKes;
    } else if (creating) d.costKes = null;
    if (body.stockQty !== undefined || creating) {
      if (!Number.isSafeInteger(body.stockQty) || body.stockQty! < 0 || body.stockQty! > 1000000) throw new BadRequestException('Initial stock must be a whole number from 0 to 1,000,000');
      d.stockQty = body.stockQty;
    }
    if (body.reorderLevel !== undefined || creating) {
      if (!Number.isSafeInteger(body.reorderLevel) || body.reorderLevel! < 0 || body.reorderLevel! > 1000000) throw new BadRequestException('reorderLevel must be a non-negative whole number');
      d.reorderLevel = body.reorderLevel;
    }
    if (body.requiresBuyerId !== undefined || creating) {
      if (body.requiresBuyerId !== undefined && typeof body.requiresBuyerId !== 'boolean') throw new BadRequestException('requiresBuyerId must be true or false');
      d.requiresBuyerId = body.requiresBuyerId ?? false;
    }
    if (!creating) delete d.stockQty; // Stock changes must go through the audited adjustment route.
    return d;
  }
}
