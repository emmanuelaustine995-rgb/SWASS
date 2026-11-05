import {
  BadRequestException, Body, Controller, Get, Param, Post, Req, ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { DbService } from '../db/db.service';

function phoneKey(value: string): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  const local = digits.startsWith('254') ? digits.slice(3) : digits.startsWith('0') ? digits.slice(1) : digits;
  if (!/^[17]\d{8}$/.test(local)) throw new BadRequestException('Enter a valid Kenyan mobile number, such as 0712345678');
  return `254${local}`;
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
    const saved = await this.db.pool.query(
      `INSERT INTO otp_requests(phone,customer_ids,code_hash,expires_at,ip_address)
       VALUES($1,$2::uuid[],$3,now()+interval '5 minutes',$4::inet) RETURNING id`,
      [phone, ids, codeHash(code), ip],
    );
    if (ids.length) {
      try {
        await this.sendSms(phone, `Your SWASS receipt recovery code is ${code}. It expires in 5 minutes. Do not share it.`);
      } catch {
        await this.db.pool.query(`UPDATE otp_requests SET expires_at=now() WHERE id=$1`, [saved.rows[0].id]);
        throw new ServiceUnavailableException('SMS delivery failed. Please try again later or contact the business.');
      }
    }
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
      `SELECT r.id,r.receipt_no,r.subtotal_kes,r.discount_kes,r.total_kes,r.payment_method,r.status,r.issued_at,r.qr_token,
              s.name AS store_name,s.location AS store_location,s.logo_data,
              t.name AS business_name,t.phone AS business_phone,t.email AS business_email,
              c.full_name AS customer_name,c.phone AS customer_phone,c.email AS customer_email,
              COALESCE(json_agg(json_build_object(
                'name',ri.name,'qty',ri.qty,'unitPriceKes',ri.unit_price_kes,'lineTotalKes',ri.line_total_kes
              ) ORDER BY ri.id) FILTER (WHERE ri.id IS NOT NULL),'[]'::json) AS items
       FROM recovery_sessions rs
       JOIN otp_requests o ON o.id=rs.otp_request_id
       JOIN receipts r ON r.customer_id=ANY(o.customer_ids)
       JOIN stores s ON s.id=r.store_id
       JOIN tenants t ON t.id=r.tenant_id
       LEFT JOIN customers c ON c.id=r.customer_id AND c.tenant_id=r.tenant_id
       LEFT JOIN receipt_items ri ON ri.receipt_id=r.id
       WHERE rs.token_hash=$1 AND rs.expires_at>now()
       GROUP BY r.id,s.id,t.id,c.id
       ORDER BY r.issued_at DESC LIMIT 50`, [hash(token)],
    );
    if (!rows.length) {
      const valid = await this.db.pool.query(`SELECT 1 FROM recovery_sessions WHERE token_hash=$1 AND expires_at>now()`, [hash(token)]);
      if (!valid.rowCount) throw new BadRequestException('Recovery session expired. Request a new code.');
    }
    return { receipts: rows.map((r: any) => ({
      ...r,
      subtotalKes: Number(r.subtotal_kes),
      discountKes: Number(r.discount_kes),
      totalKes: Number(r.total_kes),
    })) };
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
    // Africa's Talking is the preferred Kenya SMS route. Twilio remains supported as fallback.
    const atUsername = process.env.AT_USERNAME;
    const atApiKey = process.env.AT_API_KEY;
    if (atUsername && atApiKey) {
      const form = new URLSearchParams({ username: atUsername, to: `+${to}`, message });
      if (process.env.AT_SENDER_ID) form.set('from', process.env.AT_SENDER_ID);
      // Sandbox credentials must use the Sandbox API host; live credentials use the live host.
      const atBaseUrl = atUsername === 'sandbox'
        ? 'https://api.sandbox.africastalking.com/version1/messaging'
        : 'https://api.africastalking.com/version1/messaging';
      const response = await fetch(atBaseUrl, {
        method: 'POST',
        headers: { apiKey: atApiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      });
      const rawBody = await response.text();
      let result: any = {};
      try { result = rawBody ? JSON.parse(rawBody) : {}; } catch { result = {}; }
      const smsData = result?.SMSMessageData;
      const recipients = smsData?.Recipients;
      // Log only provider status information. Never log API keys, phone numbers, or OTP text.
      const providerMessage = String(smsData?.Message ?? result?.message ?? '').slice(0, 240);
      if (!response.ok) {
        throw new Error(`Africa's Talking rejected SMS (HTTP ${response.status})${providerMessage ? `: ${providerMessage}` : ''}`);
      }
      if (Array.isArray(recipients) && recipients.length) {
        const rejected = recipients.filter((r: any) => Number(r.statusCode) !== 101);
        if (rejected.length) {
          const reasons = rejected.map((r: any) =>
            `code ${String(r.statusCode ?? 'unknown')}: ${String(r.status ?? r.statusMessage ?? 'rejected').slice(0, 160)}`,
          ).join('; ');
          throw new Error(`Africa's Talking rejected OTP recipient: ${reasons}`);
        }
      } else {
        throw new Error(`Africa's Talking returned no recipient status${providerMessage ? `: ${providerMessage}` : ''}`);
      }
      return;
    }
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const auth = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM || process.env.TWILIO_FROM_NUMBER;
    if (!sid || !auth || !from) {
      if (process.env.NODE_ENV === 'production') throw new Error('Configure Africa\'s Talking or Twilio SMS credentials');
      return;
    }
    const form = new URLSearchParams({ To: `+${to}`, From: from, Body: message });
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${sid}:${auth}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
    });
    if (!response.ok) throw new Error('Twilio SMS delivery failed');
  }
}
