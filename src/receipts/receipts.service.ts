import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable,
} from '@nestjs/common';
import { createHmac, randomBytes } from 'crypto';
import { PoolClient } from 'pg';
import { AuthUser } from '../auth/auth';
import { DbService } from '../db/db.service';

export interface CreateReceiptDto {
  clientUuid: string;                 // generated on the till; makes retries safe
  receiptNo: string;                  // e.g. NBO1-T2-000045, unique per shop
  issuedAt?: string;                  // ISO time at the till (offline sales)
  paymentMethod: 'cash' | 'mpesa' | 'card';
  discountKes?: number;
  items: { productId: string; qty: number; unitPriceKes?: number; serialNo?: string }[];
  customer?: { fullName: string; phone: string; email?: string; nationalId?: string };
}

const RECEIPT_FEE_KES = 2;
const GRACE_DAYS = 3;
const POINTS_PER_KES = 100;           // 1 point per KSh 100 spent (adjust to taste)
const CASHIER_MAX_DISCOUNT_PCT = Number(process.env.CASHIER_MAX_DISCOUNT_PCT ?? 5);
if (!Number.isInteger(CASHIER_MAX_DISCOUNT_PCT) || CASHIER_MAX_DISCOUNT_PCT < 0 || CASHIER_MAX_DISCOUNT_PCT > 100) {
  throw new Error('CASHIER_MAX_DISCOUNT_PCT must be a whole number from 0 to 100');
}

@Injectable()
export class ReceiptsService {
  constructor(private db: DbService) {}

  async list(user: AuthUser, filters: { q?: string; from?: string; to?: string; limit?: string }) {
    if (!user.tenantId || !user.storeId) throw new ForbiddenException('User is not tied to a store');
    const limit = Math.min(100, Math.max(1, Number.parseInt(filters.limit ?? '30', 10) || 30));
    const from = filters.from && /^\d{4}-\d{2}-\d{2}$/.test(filters.from) ? filters.from : null;
    const to = filters.to && /^\d{4}-\d{2}-\d{2}$/.test(filters.to) ? filters.to : null;
    const q = (filters.q ?? '').trim().slice(0, 100);
    const digits = q.replace(/\D/g, '');
    const phoneSearch = digits.startsWith('254') && digits.length === 12 ? digits
      : digits.startsWith('0') && digits.length === 10 ? `254${digits.slice(1)}`
      : digits.length === 9 ? `254${digits}` : '';
    const idHash = /^[0-9A-Za-z-]{5,30}$/.test(q) ? hashNationalId(q) : '';
    const idLast4 = digits.length >= 4 ? digits.slice(-4) : '';
    const { rows } = await this.db.pool.query(
      `SELECT r.id, r.receipt_no, r.issued_at, r.total_kes, r.subtotal_kes, r.discount_kes,
              r.payment_method, r.status, c.full_name AS customer_name, c.phone AS customer_phone,
              c.email AS customer_email, c.national_id_last4 AS customer_id_last4,
              u.full_name AS cashier_name,
              COALESCE(json_agg(json_build_object('name', ri.name, 'qty', ri.qty,
                'serialNo', ri.serial_no, 'unitPriceKes', ri.unit_price_kes, 'lineTotalKes', ri.line_total_kes))
                FILTER (WHERE ri.id IS NOT NULL), '[]'::json) AS items
         FROM receipts r
         LEFT JOIN customers c ON c.id = r.customer_id AND c.tenant_id = r.tenant_id
         LEFT JOIN users u ON u.id = r.cashier_id AND u.tenant_id = r.tenant_id
         LEFT JOIN receipt_items ri ON ri.receipt_id = r.id
        WHERE r.tenant_id = $1 AND r.store_id = $2
          AND ($3::date IS NULL OR r.issued_at >= $3::date)
          AND ($4::date IS NULL OR r.issued_at < ($4::date + interval '1 day'))
          AND ($5 = '' OR r.receipt_no ILIKE '%' || $5 || '%'
               OR COALESCE(c.full_name, '') ILIKE '%' || $5 || '%'
               OR COALESCE(c.phone, '') ILIKE '%' || $5 || '%'
               OR ($8 <> '' AND c.phone = $8)
               OR ($7 <> '' AND c.national_id_hash = $7)
               OR ($9 <> '' AND c.national_id_last4 = $9)
               OR EXISTS (SELECT 1 FROM receipt_items search_item
                           WHERE search_item.receipt_id = r.id
                             AND COALESCE(search_item.serial_no, '') ILIKE '%' || $5 || '%')
               OR r.total_kes::text ILIKE '%' || $5 || '%')
        GROUP BY r.id, c.full_name, c.phone, c.email, c.national_id_last4, u.full_name
        ORDER BY r.issued_at DESC, r.id DESC LIMIT $6`,
      [user.tenantId, user.storeId, from, to, q, limit, idHash, phoneSearch, idLast4],
    );
    return { receipts: rows.map((r: any) => ({
      id: r.id, receiptNo: r.receipt_no, issuedAt: r.issued_at,
      totalKes: Number(r.total_kes), subtotalKes: Number(r.subtotal_kes),
      discountKes: Number(r.discount_kes), paymentMethod: r.payment_method,
      status: r.status, cashier: { name: r.cashier_name || 'Staff' }, customer: r.customer_name ? {
        fullName: r.customer_name, phone: r.customer_phone, email: r.customer_email, nationalIdLast4: r.customer_id_last4,
      } : null, items: r.items,
    })) };
  }

  async create(user: AuthUser, dto: CreateReceiptDto) {
    this.validate(dto);
    if (!user.tenantId || !user.storeId) throw new ForbiddenException('User is not tied to a store');

    try {
      return await this.db.tx((c) => this.createInTx(c, user, dto));
    } catch (err: any) {
      if (err?.code === '23505') {
        // Two requests for the same sale racing each other: the loser returns the stored receipt.
        const stored = await this.db.tx((c) => this.findByClientUuid(c, user.tenantId!, dto.clientUuid, dto));
        if (stored) return stored;
        // A different sale already uses this receipt number.
        if (String(err.constraint).includes('receipt_no')) {
          throw new ConflictException('This receipt number is already used by another sale');
        }
        if (String(err.constraint).includes('client_uuid')) {
          throw new ConflictException('This offline sale ID has already been used');
        }
      }
      throw err;
    }
  }

  private async createInTx(c: PoolClient, user: AuthUser, dto: CreateReceiptDto) {
    const tenantId = user.tenantId!;
    const businessResult = await c.query(
      `SELECT t.name AS business_name, t.phone AS business_phone, t.email AS business_email,
              s.name AS store_name, s.location AS store_location,
              s.receipt_header, s.receipt_footer, s.logo_data,
              u.full_name AS cashier_name, u.phone AS cashier_phone
         FROM tenants t JOIN stores s ON s.tenant_id=t.id
         LEFT JOIN users u ON u.id=$3 AND u.tenant_id=t.id AND u.store_id=s.id
        WHERE t.id=$1 AND s.id=$2 LIMIT 1`,
      [tenantId, user.storeId, user.sub],
    );
    if (!businessResult.rows[0]) throw new ForbiddenException('Business details could not be loaded');
    const businessRow = businessResult.rows[0];
    const business = {
      name: businessRow.business_name,
      phone: businessRow.business_phone,
      email: businessRow.business_email,
      storeName: businessRow.store_name,
      location: businessRow.store_location,
      receiptHeader: businessRow.receipt_header,
      receiptFooter: businessRow.receipt_footer,
      logoData: businessRow.logo_data,
    };
    const cashier = { name: businessRow.cashier_name || 'Staff', phone: businessRow.cashier_phone || null };

    // 1. Already stored (offline retry)? Return it without charging again.
    const existing = await this.findByClientUuid(c, tenantId, dto.clientUuid, dto);
    if (existing) return { ...existing, business };

    // 2. Subscription must be active, or inside the grace period.
    const sub = await c.query(
      `SELECT 1 FROM subscriptions
        WHERE tenant_id = $1 AND status = 'active'
          AND ends_at + make_interval(days => $2) > now() LIMIT 1`,
      [tenantId, GRACE_DAYS],
    );
    if (!sub.rowCount) throw new HttpException('Subscription expired', 402);

    // 3. Lock the wallet and check the KSh 2 fee fits inside balance + overdraft.
    const w = await c.query(
      `SELECT balance_kes, overdraft_limit_kes FROM wallets WHERE tenant_id = $1 FOR UPDATE`,
      [tenantId],
    );
    if (!w.rowCount) throw new HttpException('No wallet for this shop', 402);
    if (BigInt(w.rows[0].balance_kes) - BigInt(RECEIPT_FEE_KES) < -BigInt(w.rows[0].overdraft_limit_kes)) {
      throw new HttpException('Wallet balance too low. Top up to keep issuing receipts', 402);
    }

    // 4. Lock the products and price the sale from the database, never from the client.
    const ids = dto.items.map((i) => i.productId);
    const pr = await c.query(
      `SELECT id, name, price_kes, cost_kes, requires_buyer_id FROM products
        WHERE id = ANY($1::uuid[]) AND tenant_id = $2 AND store_id = $3 FOR UPDATE`,
      [ids, tenantId, user.storeId],
    );
    const byId = new Map(pr.rows.map((p) => [p.id, p]));
    if (byId.size !== new Set(ids).size) throw new BadRequestException('Unknown product in this store');

    const lines = dto.items.map((i) => {
      const p = byId.get(i.productId);
      const unit = i.unitPriceKes === undefined ? Number(p.price_kes) : i.unitPriceKes;
      if (!Number.isSafeInteger(unit) || unit < 1 || unit > 100000000000) throw new BadRequestException('Customer selling price must be a positive whole KSh amount');
      const total = i.qty * unit;
      if (!Number.isSafeInteger(unit) || !Number.isSafeInteger(total)) {
        throw new BadRequestException('Product price or line total exceeds the supported amount');
      }
      return {
        productId: i.productId, name: p.name as string, serialNo: i.serialNo ?? null,
        qty: i.qty, unit, costUnit: Number(p.cost_kes ?? 0), total,
      };
    });
    const subtotal = lines.reduce((s, l) => s + l.total, 0);
    if (!Number.isSafeInteger(subtotal)) throw new BadRequestException('Sale total exceeds the supported amount');
    const discount = dto.discountKes ?? 0;
    if (discount > subtotal) throw new BadRequestException('Discount exceeds the total');
    if (user.role === 'cashier' && BigInt(discount) * 100n > BigInt(subtotal) * BigInt(CASHIER_MAX_DISCOUNT_PCT)) {
      throw new ForbiddenException(`Cashiers may give at most ${CASHIER_MAX_DISCOUNT_PCT}% discount`);
    }
    const total = subtotal - discount;

    // 5. High-value items need the buyer's details.
    const needsBuyer = lines.some((l) => byId.get(l.productId).requires_buyer_id);
    if (needsBuyer && !(dto.customer?.fullName && dto.customer.phone && dto.customer.nationalId)) {
      throw new BadRequestException('Buyer name, phone and National ID are required for this item');
    }
    const customerId = dto.customer ? await this.upsertCustomer(c, tenantId, dto.customer) : null;

    // 6. The receipt and its items.
    const issuedAt = this.safeIssuedAt(dto.issuedAt);
    const qrToken = randomBytes(16).toString('base64url');
    const r = await c.query(
      `INSERT INTO receipts (tenant_id, store_id, receipt_no, cashier_id, customer_id,
          subtotal_kes, discount_kes, total_kes, payment_method, qr_token, client_uuid, issued_at, request_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, receipt_no, total_kes, qr_token, status, issued_at`,
      [tenantId, user.storeId, dto.receiptNo, user.sub, customerId, subtotal, discount, total,
       dto.paymentMethod, qrToken, dto.clientUuid, issuedAt, this.requestFingerprint(dto)],
    );
    const receipt = r.rows[0];

    for (const l of lines) {
      await c.query(
        `INSERT INTO receipt_items (receipt_id, product_id, name, serial_no, qty, unit_price_kes, line_total_kes, unit_cost_kes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [receipt.id, l.productId, l.name, l.serialNo, l.qty, l.unit, l.total, l.costUnit],
      );
      // 7. Stock goes down (it may go negative after an offline sale).
      await c.query(`UPDATE products SET stock_qty = stock_qty - $1 WHERE id = $2`, [l.qty, l.productId]);
      await c.query(
        `INSERT INTO stock_movements (product_id, change_qty, reason, receipt_id, user_id)
         VALUES ($1, $2, 'sale', $3, $4)`,
        [l.productId, -l.qty, receipt.id, user.sub],
      );
    }

    // 8. Charge the KSh 2 fee.
    await c.query(`UPDATE wallets SET balance_kes = balance_kes - $1 WHERE tenant_id = $2`, [RECEIPT_FEE_KES, tenantId]);
    await c.query(
      `INSERT INTO wallet_transactions (tenant_id, change_kes, reason, receipt_id) VALUES ($1, $2, 'receipt_fee', $3)`,
      [tenantId, -RECEIPT_FEE_KES, receipt.id],
    );

    // Record SWASS's earned processing fee separately from the shop's sales proceeds.
    await c.query(
      `INSERT INTO platform_financial_ledger (tenant_id, receipt_id, entry_type, amount_kes)
       VALUES ($1, $2, 'receipt_fee_revenue', $3)`,
      [tenantId, receipt.id, RECEIPT_FEE_KES],
    );

    // 9. Loyalty points for identified buyers.
    let pointsEarned = 0;
    if (customerId) {
      pointsEarned = Math.floor(total / POINTS_PER_KES);
      if (pointsEarned > 2147483647) throw new BadRequestException('Loyalty points exceed the supported limit');
      if (pointsEarned > 0) {
        await c.query(
          `INSERT INTO loyalty_ledger (customer_id, receipt_id, points, reason) VALUES ($1,$2,$3,'purchase')`,
          [customerId, receipt.id, pointsEarned],
        );
        await c.query(`UPDATE customers SET loyalty_points = loyalty_points + $1 WHERE id = $2`, [pointsEarned, customerId]);
      }
    }

    return {
      id: receipt.id, receiptNo: receipt.receipt_no,
      subtotalKes: subtotal, discountKes: discount, totalKes: Number(receipt.total_kes),
      qrToken: receipt.qr_token, status: receipt.status, issuedAt: receipt.issued_at,
      cashier, pointsEarned, duplicate: false, business,
    };
  }

  private async findByClientUuid(c: PoolClient, tenantId: string, clientUuid: string, dto: CreateReceiptDto) {
    const { rows } = await c.query(
      `SELECT r.id, r.receipt_no, r.subtotal_kes, r.discount_kes, r.total_kes, r.qr_token, r.status, r.request_hash,
              r.issued_at, u.full_name AS cashier_name, u.phone AS cashier_phone
         FROM receipts r LEFT JOIN users u ON u.id = r.cashier_id
        WHERE r.client_uuid = $1 AND r.tenant_id = $2`,
      [clientUuid, tenantId],
    );
    if (!rows[0]) return null;
    // Reusing an idempotency key with a different payload must not silently return another sale.
    if (rows[0].request_hash && rows[0].request_hash !== this.requestFingerprint(dto)) {
      throw new ConflictException('This offline sale ID was already used for different sale details');
    }
    return {
      id: rows[0].id, receiptNo: rows[0].receipt_no,
      subtotalKes: Number(rows[0].subtotal_kes), discountKes: Number(rows[0].discount_kes),
      totalKes: Number(rows[0].total_kes),
      qrToken: rows[0].qr_token, status: rows[0].status, issuedAt: rows[0].issued_at,
      cashier: { name: rows[0].cashier_name || 'Staff', phone: rows[0].cashier_phone || null },
      pointsEarned: 0, duplicate: true,
    };
  }

  private async upsertCustomer(c: PoolClient, tenantId: string, cust: NonNullable<CreateReceiptDto['customer']>) {
    const phone = normalisePhone(cust.phone);
    const idHash = cust.nationalId ? hashNationalId(cust.nationalId) : null;
    const last4 = cust.nationalId ? cust.nationalId.replace(/[^0-9A-Za-z]/g, '').slice(-4) : null;
    const { rows } = await c.query(
      `INSERT INTO customers (tenant_id, full_name, phone, email, national_id_hash, national_id_last4)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, phone) DO UPDATE
         SET full_name = EXCLUDED.full_name,
             email = COALESCE(EXCLUDED.email, customers.email),
             national_id_hash = COALESCE(customers.national_id_hash, EXCLUDED.national_id_hash),
             national_id_last4 = COALESCE(customers.national_id_last4, EXCLUDED.national_id_last4)
       WHERE customers.national_id_hash IS NULL
          OR EXCLUDED.national_id_hash IS NULL
          OR customers.national_id_hash = EXCLUDED.national_id_hash
       RETURNING id`,
      [tenantId, cust.fullName.trim(), phone, cust.email?.trim().toLowerCase() || null, idHash, last4],
    );
    if (!rows[0]) {
      throw new ConflictException('The supplied National ID does not match this customer phone number');
    }
    return rows[0].id as string;
  }

  /** HMAC fingerprint detects idempotency-key reuse without persisting customer ID data. */
  private requestFingerprint(dto: CreateReceiptDto): string {
    const canonical = {
      receiptNo: dto.receiptNo, issuedAt: dto.issuedAt ?? null, paymentMethod: dto.paymentMethod,
      discountKes: dto.discountKes ?? 0,
      items: dto.items.map((i) => ({ productId: i.productId, qty: i.qty, unitPriceKes: i.unitPriceKes ?? null, serialNo: i.serialNo ?? null })),
      customer: dto.customer ? {
        fullName: dto.customer.fullName.trim(), phone: normalisePhone(dto.customer.phone), email: dto.customer.email?.trim().toLowerCase() || null,
        nationalId: dto.customer.nationalId ? hashNationalId(dto.customer.nationalId) : null,
      } : null,
    };
    return createHmac('sha256', process.env.SWASS_ID_SECRET!).update(JSON.stringify(canonical)).digest('hex');
  }

  /** Offline receipts keep the till's time, but never a time in the future. */
  private safeIssuedAt(value?: string): Date {
    const t = value ? new Date(value) : new Date();
    if (Number.isNaN(t.getTime())) throw new BadRequestException('Invalid issuedAt');
    return t.getTime() > Date.now() + 5 * 60_000 ? new Date() : t;
  }

  private validate(dto: CreateReceiptDto) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!dto || !uuid.test(dto.clientUuid ?? '')) throw new BadRequestException('clientUuid must be a UUID');
    if (typeof dto.receiptNo !== 'string' || !dto.receiptNo.trim() || dto.receiptNo.length > 80) throw new BadRequestException('receiptNo must be a non-empty string of at most 80 characters');
    if (!['cash', 'mpesa', 'card'].includes(dto.paymentMethod)) throw new BadRequestException('Invalid paymentMethod');
    if (!Array.isArray(dto.items) || dto.items.length === 0 || dto.items.length > 100) throw new BadRequestException('A sale must contain between 1 and 100 items');
    for (const i of dto.items) {
      if (!uuid.test(i.productId ?? '') || !Number.isInteger(i.qty) || i.qty < 1 || i.qty > 1000000) {
        throw new BadRequestException('Each item needs a productId and a whole qty of 1 or more');
      }
      if (i.unitPriceKes !== undefined && (!Number.isSafeInteger(i.unitPriceKes) || i.unitPriceKes < 1 || i.unitPriceKes > 100000000000)) {
        throw new BadRequestException('Customer selling price must be a positive whole KSh amount');
      }
    }
    const d = dto.discountKes ?? 0;
    if (!Number.isSafeInteger(d) || d < 0) throw new BadRequestException('discountKes must be a non-negative whole number');
    if (dto.customer && (typeof dto.customer.fullName !== 'string' || !dto.customer.fullName.trim() || dto.customer.fullName.length > 160)) {
      throw new BadRequestException('Customer fullName is required and must be at most 160 characters');
    }
    if (dto.customer && typeof dto.customer.phone !== 'string') throw new BadRequestException('Customer phone is required');
    if (dto.customer?.email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dto.customer.email.trim()) || dto.customer.email.length > 254)) throw new BadRequestException('Enter a valid customer email address');
    if (dto.customer?.nationalId && !/^[0-9A-Za-z-]{5,30}$/.test(dto.customer.nationalId.trim())) {
      throw new BadRequestException('Invalid National ID format');
    }
  }
}

/** 07XX / 01XX / +2547XX / 2547XX all become 2547XXXXXXXX. */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  const local = digits.startsWith('254') ? digits.slice(3) : digits.startsWith('0') ? digits.slice(1) : digits;
  if (!/^[17]\d{8}$/.test(local)) throw new BadRequestException('Invalid Kenyan phone number');
  return `254${local}`;
}

/** Keyed hash so a database leak does not reveal National ID numbers. */
export function hashNationalId(id: string): string {
  const secret = process.env.SWASS_ID_SECRET;
  if (!secret) throw new Error('SWASS_ID_SECRET is not set');
  return createHmac('sha256', secret).update(id.trim().toUpperCase()).digest('hex');
}
