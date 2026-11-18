import { BadRequestException, Body, Controller, Get, Headers, HttpException, Param, Post, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { DbService } from '../db/db.service';
import { MpesaService } from '../mpesa/mpesa.controller';

@Controller('api/v1/second-hand-special-recovery')
export class SecondHandSpecialRecoveryController {
  constructor(private db: DbService, private mpesa: MpesaService) {}

  @Post('request')
  async request(@Body() body: any) {
    const nationalId = typeof body?.nationalId === 'string' ? body.nationalId.trim() : '';
    if (!nationalId || nationalId.length > 40) throw new BadRequestException('Enter the seller National ID.');
    const phone = this.mpesa.normalizePhone(body?.phone);
    const found = await this.db.pool.query(
      `SELECT id FROM second_hand_phone_declarations
        WHERE regexp_replace(lower(national_id), '[^a-z0-9]', '', 'g') =
              regexp_replace(lower($1), '[^a-z0-9]', '', 'g')
          AND regexp_replace(seller_phone, '[^0-9]', '', 'g') IN ($2, substring($2 from 4), '0' || substring($2 from 4))
        ORDER BY created_at DESC LIMIT 1`,
      [nationalId, phone],
    );
    if (!found.rowCount) throw new BadRequestException('No Special Receipt matched those seller details. Check the National ID and phone number.');
    const declarationId = found.rows[0].id;
    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const inserted = await this.db.pool.query(
      `INSERT INTO second_hand_special_receipt_recoveries
       (declaration_id, phone, amount_kes, status, token_hash)
       VALUES ($1,$2,50,'pending',$3) RETURNING id`,
      [declarationId, phone, tokenHash],
    );
    const paymentId = inserted.rows[0].id;
    try {
      const checkoutId = await this.mpesa.initiate({ phone, amount: 50, purpose: 'second_hand_recovery', paymentId });
      await this.db.pool.query(
        `UPDATE second_hand_special_receipt_recoveries SET checkout_request_id=$1 WHERE id=$2`,
        [checkoutId, paymentId],
      );
    } catch (error) {
      const timedOut = error instanceof ServiceUnavailableException && error.message.toLowerCase().includes('timed out');
      if (!timedOut) await this.db.pool.query(
        `UPDATE second_hand_special_receipt_recoveries SET status='failed' WHERE id=$1 AND status='pending'`,
        [paymentId],
      );
      throw error;
    }
    return { paymentId, recoveryToken: token, amountKes: 50, status: 'pending', message: 'An M-Pesa prompt for KSh 50 has been requested. Complete it to unlock the Special Receipt.' };
  }

  @Get('status/:id')
  async status(@Param('id') id: string, @Headers('x-recovery-token') token: string) {
    const row = await this.authorizedPayment(id, token);
    return { paymentId: row.id, status: row.status, amountKes: Number(row.amount_kes), paidAt: row.paid_at };
  }

  @Get('declaration')
  async declaration(@Headers('x-recovery-token') token: string) {
    if (!token || token.length > 256) throw new HttpException('Recovery access denied.', 403);
    const hash = createHash('sha256').update(token).digest('hex');
    const result = await this.db.pool.query(
      `SELECT d.declaration_ref AS "declarationRef", d.seller_name AS "sellerName",
        d.national_id AS "nationalId", d.seller_phone AS "sellerPhone",
        d.alternative_phone AS "alternativePhone", d.residential_address AS "residentialAddress",
        d.phone_make_model AS "productName", d.imei1, d.imei2, d.serial_number AS "serialNumber",
        d.phone_condition AS condition, d.purchase_price_kes AS "purchasePriceKes",
        d.no_receipt_reason AS "receiptStatus", d.sale_type AS "saleType",
        d.witness_name AS "witnessName", d.witness_phone AS "witnessPhone",
        d.declaration_version AS "declarationVersion", d.accepted_at AS "acceptedAt",
        d.created_at AS "createdAt", d.shop_acknowledged AS "shopAcknowledged"
       FROM second_hand_special_receipt_recoveries r
       JOIN second_hand_phone_declarations d ON d.id=r.declaration_id
       WHERE r.token_hash=$1 AND r.status='success'
       ORDER BY r.paid_at DESC LIMIT 1`,
      [hash],
    );
    if (!result.rowCount) throw new HttpException('Payment must be confirmed before the Special Receipt can be opened.', 403);
    return { declaration: result.rows[0] };
  }

  private async authorizedPayment(id: string, token: string) {
    if (!token || token.length > 256) throw new HttpException('Recovery access denied.', 403);
    const hash = createHash('sha256').update(token).digest('hex');
    const result = await this.db.pool.query(
      `SELECT id, amount_kes, status, paid_at FROM second_hand_special_receipt_recoveries
       WHERE id=$1 AND token_hash=$2 LIMIT 1`,
      [id, hash],
    );
    if (!result.rowCount) throw new HttpException('Recovery access denied.', 403);
    return result.rows[0];
  }
}
