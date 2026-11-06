import { BadRequestException, Controller, Get, HttpException, HttpStatus, Param, Post, Body, Req, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { DbService } from '../db/db.service';
import { hashNationalId, normalisePhone } from './receipts.service';
import { MpesaService } from '../mpesa/mpesa.controller';

const RECOVERY_FEE_KES = 10;
function hashToken(value: string): string { return createHash('sha256').update(value).digest('hex'); }

@Controller('api/v1/receipt-recovery')
export class ReceiptRecoveryController {
  constructor(private db: DbService, private mpesa: MpesaService) {}

  @Post('request')
  async requestPayment(@Body() body: { phone?: string; nationalId?: string }) {
    if (typeof body?.nationalId !== 'string' || !/^[0-9A-Za-z-]{5,30}$/.test(body.nationalId.trim())) {
      throw new BadRequestException('Enter the National ID used when purchasing');
    }
    const phone = normalisePhone(String(body?.phone ?? ''));
    const idHash = hashNationalId(body.nationalId);
    const matches = await this.db.pool.query(
      `SELECT 1 FROM customers WHERE phone=$1 AND national_id_hash=$2 LIMIT 1`,
      [phone, idHash],
    );
    if (!matches.rowCount) throw new HttpException('The National ID and phone number do not match a customer record.', HttpStatus.NOT_FOUND);

    const recoveryToken = randomBytes(32).toString('base64url');
    const inserted = await this.db.pool.query(
      `INSERT INTO receipt_recovery_payments(phone,national_id_hash,amount_kes,status,token_hash)
       VALUES($1,$2,$3,'pending',$4) RETURNING id`,
      [phone, idHash, RECOVERY_FEE_KES, hashToken(recoveryToken)],
    );
    const paymentId: string = inserted.rows[0].id;
    try {
      const checkoutId = await this.mpesa.initiate({ phone, amount: RECOVERY_FEE_KES, purpose: 'recovery', paymentId });
      await this.db.pool.query(
        `UPDATE receipt_recovery_payments SET checkout_request_id=$1 WHERE id=$2`,
        [checkoutId, paymentId],
      );
      return { paymentId, recoveryToken, status: 'pending', amountKes: RECOVERY_FEE_KES, message: 'M-Pesa payment request sent. Complete the KSh 10 prompt to unlock all matching receipts.' };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!(error instanceof ServiceUnavailableException && message.toLowerCase().includes('timed out'))) {
        await this.db.pool.query(`UPDATE receipt_recovery_payments SET status='failed' WHERE id=$1 AND status='pending'`, [paymentId]);
      }
      throw error;
    }
  }

  @Get('status/:id')
  async paymentStatus(@Param('id') id: string, @Req() req: any) {
    const token = String(req.headers['x-recovery-token'] ?? '');
    if (!token || token.length > 200) throw new BadRequestException('Invalid recovery session');
    const result = await this.db.pool.query(
      `SELECT status,amount_kes,mpesa_receipt_no FROM receipt_recovery_payments WHERE id=$1 AND token_hash=$2`,
      [id, hashToken(token)],
    );
    if (!result.rowCount) throw new HttpException('Recovery payment not found', HttpStatus.NOT_FOUND);
    const row = result.rows[0];
    return { status: row.status, amountKes: Number(row.amount_kes), mpesaReceiptNumber: row.mpesa_receipt_no };
  }

  @Get('receipts')
  async recoveredReceipts(@Req() req: any) {
    const token = String(req.headers['x-recovery-token'] ?? '');
    if (!token || token.length > 200) throw new BadRequestException('A valid recovery token is required');
    const { rows } = await this.db.pool.query(
      `SELECT r.id,r.receipt_no,r.subtotal_kes,r.discount_kes,r.total_kes,r.payment_method,r.status,r.issued_at,r.qr_token,
              s.name AS store_name,s.location AS store_location,s.logo_data,
              t.name AS business_name,t.phone AS business_phone,t.email AS business_email,
              c.full_name AS customer_name,c.phone AS customer_phone,c.national_id_last4 AS customer_id_last4,
              u.full_name AS cashier_name,u.phone AS cashier_phone,
              COALESCE(json_agg(json_build_object(
                'name',ri.name,'serialNo',ri.serial_no,'qty',ri.qty,'unitPriceKes',ri.unit_price_kes,'lineTotalKes',ri.line_total_kes
              ) ORDER BY ri.id) FILTER (WHERE ri.id IS NOT NULL),'[]'::json) AS items
       FROM receipt_recovery_payments rp
       JOIN customers c ON c.phone=rp.phone AND c.national_id_hash=rp.national_id_hash
       JOIN receipts r ON r.customer_id=c.id
       JOIN stores s ON s.id=r.store_id
       JOIN tenants t ON t.id=r.tenant_id
       LEFT JOIN users u ON u.id=r.cashier_id AND u.tenant_id=r.tenant_id
       LEFT JOIN receipt_items ri ON ri.receipt_id=r.id
       WHERE rp.token_hash=$1 AND rp.status='success'
       GROUP BY r.id,s.id,t.id,c.id,u.id
       ORDER BY r.issued_at DESC LIMIT 500`,
      [hashToken(token)],
    );
    const payment = await this.db.pool.query(
      `SELECT status FROM receipt_recovery_payments WHERE token_hash=$1`, [hashToken(token)],
    );
    if (!payment.rowCount) throw new BadRequestException('Recovery session not found');
    if (payment.rows[0].status !== 'success') throw new HttpException('Complete the KSh 10 M-Pesa payment before viewing receipts.', HttpStatus.PAYMENT_REQUIRED);
    return { receipts: rows.map((r: any) => ({
      ...r,
      cashier: { name: r.cashier_name || 'Staff', phone: r.cashier_phone || null },
      subtotalKes: Number(r.subtotal_kes), discountKes: Number(r.discount_kes), totalKes: Number(r.total_kes),
    })) };
  }

  @Get('verify/:token')
  async verifyReceipt(@Param('token') token: string) {
    if (!token || token.length > 100) throw new BadRequestException('Invalid receipt token');
    const { rows } = await this.db.pool.query(
      `SELECT r.receipt_no,r.total_kes,r.status,r.issued_at,s.name AS store_name
       FROM receipts r JOIN stores s ON s.id=r.store_id WHERE r.qr_token=$1 LIMIT 1`, [token],
    );
    if (!rows[0]) return { valid: false, message: 'Receipt not found' };
    const r = rows[0];
    return { valid: r.status === 'issued', receiptNo: r.receipt_no, totalKes: Number(r.total_kes), status: r.status, issuedAt: r.issued_at, storeName: r.store_name };
  }
}
