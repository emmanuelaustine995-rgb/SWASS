import {
  BadRequestException, Body, Controller, Get, Param, Post, Req,
} from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { DbService } from '../db/db.service';

function phoneKey(value: string): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) throw new BadRequestException('Enter a valid phone number');
  return digits.startsWith('0') ? `254${digits.slice(1)}` : digits;
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function codeHash(code: string): string {
  const secret = process.env.SWASS_ID_SECRET;
  if (!secret) throw new Error('SWASS_ID_SECRET is required');
  return createHmac('sha256', secret).update(`receipt-otp:${code}`).digest('hex');
}

@Controller('api/v1')
export class ReceiptRecoveryController {
  constructor(private db: DbService) {}

  @Post('receipt-recovery/request')
  async requestOtp(@Body() body: { phone?: string }, @Req() req: any) {
    if (!body?.phone) throw new BadRequestException('Phone number is required');
    const phone = phoneKey(body.phone);
    const ip = String(req.ip ?? '').replace(/^::ffff:/, '') || null;
    // Generic response prevents revealing whether a customer account exists.
    const generic = { message: 'If matching receipts exist, a verification code will be sent to the registered phone.' };
    const recent = await this.db.pool.query(
      `SELECT count(*)::int AS n FROM otp_requests WHERE phone=$1 AND created_at > now()-interval '15 minutes'`, [phone],
    );
    const ipRecent = ip ? await this.db.pool.query(
      `SELECT count(*)::int AS n FROM otp_requests WHERE ip_address=$1::inet AND created_at > now()-interval '15 minutes'`, [ip],
    ) : { rows: [{ n: 0 }] };
    if (recent.rows[0].n >= 3 || ipRecent.rows[0].n >= 10) return generic;

    const customers = await this.db.pool.query(`SELECT id FROM customers WHERE phone=$1`, [phone]);
    const ids = customers.rows.map((r: any) => r.id);
    const code = String(randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, '0');
    await this.db.pool.query(
      `INSERT INTO otp_requests(phone,customer_ids,code_hash,expires_at,ip_address)
       VALUES($1,$2::uuid[],$3,now()+interval '5 minutes',$4::inet)`,
      [phone, ids, codeHash(code), ip],
    );
    if (ids.length) await this.sendSms(phone, `Your SWASS receipt recovery code is ${code}. It expires in 5 minutes. Do not share it.`);
    // Development-only convenience. Never return OTPs in production.
    return process.env.NODE_ENV === 'production' ? generic : { ...generic, developmentCode: code };
  }

  @Post('receipt-recovery/verify')
  async verifyOtp(@Body() body: { phone?: string; code?: string }) {
    if (!body?.phone || !/^\d{6}$/.test(String(body.code ?? ''))) throw new BadRequestException('Enter your phone number and six-digit code');
    const phone = phoneKey(body.phone);
    const result = await this.db.pool.query(
      `SELECT id,customer_ids,code_hash,attempts FROM otp_requests
       WHERE phone=$1 AND verified_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1`, [phone],
    );
    const row = result.rows[0];
    const supplied = Buffer.from(codeHash(String(body.code)), 'hex');
    const expected = Buffer.from(row?.code_hash ?? '0'.repeat(64), 'hex');
    const match = !!row && row.attempts < 5 && supplied.length === expected.length && timingSafeEqual(supplied, expected);
    if (!row || row.attempts >= 5) throw new BadRequestException('Code is invalid or expired. Request a new code.');
    if (!match) {
      await this.db.pool.query(`UPDATE otp_requests SET attempts=attempts+1 WHERE id=$1`, [row.id]);
      throw new BadRequestException('Code is invalid or expired. Request a new code.');
    }
    if (!row.customer_ids?.length) throw new BadRequestException('No receipts were found for this phone number.');
    const token = randomBytes(32).toString('base64url');
    await this.db.tx(async (c) => {
      await c.query(`UPDATE otp_requests SET verified_at=now() WHERE id=$1`, [row.id]);
      await c.query(`INSERT INTO recovery_sessions(otp_request_id,token_hash,expires_at) VALUES($1,$2,now()+interval '10 minutes')`, [row.id, hash(token)]);
    });
    return { recoveryToken: token, expiresInSeconds: 600 };
  }

  @Get('receipt-recovery/receipts')
  async recoveredReceipts(@Req() req: any) {
    const token = String(req.headers['x-recovery-token'] ?? '');
    if (!token || token.length > 200) throw new BadRequestException('A valid recovery token is required');
    const { rows } = await this.db.pool.query(
      `SELECT r.id,r.receipt_no,r.total_kes,r.payment_method,r.status,r.issued_at,s.name AS store_name,
              o.customer_ids
       FROM recovery_sessions rs JOIN otp_requests o ON o.id=rs.otp_request_id
       JOIN receipts r ON r.customer_id=ANY(o.customer_ids) JOIN stores s ON s.id=r.store_id
       WHERE rs.token_hash=$1 AND rs.expires_at>now()
       ORDER BY r.issued_at DESC LIMIT 50`, [hash(token)],
    );
    if (!rows.length) {
      const valid = await this.db.pool.query(`SELECT 1 FROM recovery_sessions WHERE token_hash=$1 AND expires_at>now()`, [hash(token)]);
      if (!valid.rowCount) throw new BadRequestException('Recovery session expired. Request a new code.');
    }
    return { receipts: rows.map(({ customer_ids, ...r }: any) => ({ ...r, totalKes: Number(r.total_kes) })) };
  }

  @Get('receipts/verify/:token')
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

  private async sendSms(to: string, message: string) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const auth = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM;
    if (!sid || !auth || !from) {
      if (process.env.NODE_ENV === 'production') throw new Error('SMS provider is not configured');
      return; // local development code is returned only outside production
    }
    const form = new URLSearchParams({ To: `+${to}`, From: from, Body: message });
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${sid}:${auth}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
    });
    if (!response.ok) throw new Error('SMS delivery failed');
  }
}
