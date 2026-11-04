import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpException,
  HttpStatus, Injectable, Param, Post, Req, ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { DbService } from '../db/db.service';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';

const MONTHLY_KES = 100;
const YEARLY_KES = 900;
const MAX_TOPUP_KES = 150000;
type Purpose = 'subscription' | 'wallet_topup';

@Injectable()
export class MpesaService {
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  private config() {
    const env = process.env.MPESA_ENV ?? 'sandbox';
    if (!['sandbox', 'production'].includes(env)) throw new ServiceUnavailableException('M-Pesa environment is not configured');
    const base = env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
    const required = ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY', 'MPESA_CALLBACK_URL', 'MPESA_CALLBACK_TOKEN'];
    if (required.some((key) => !process.env[key])) throw new ServiceUnavailableException('M-Pesa is not configured yet');
    const callback = new URL(process.env.MPESA_CALLBACK_URL!);
    if (callback.protocol !== 'https:') throw new ServiceUnavailableException('M-Pesa callback URL must use HTTPS');
    return { base, shortcode: process.env.MPESA_SHORTCODE!, passkey: process.env.MPESA_PASSKEY!, callbackUrl: callback.toString() };
  }

  normalizePhone(value: unknown): string {
    if (typeof value !== 'string') throw new BadRequestException('Enter a valid M-Pesa phone number');
    let phone = value.replace(/[\s()-]/g, '');
    if (phone.startsWith('+')) phone = phone.slice(1);
    if (phone.startsWith('0') && phone.length === 10) phone = `254${phone.slice(1)}`;
    if (/^[17]\d{8}$/.test(phone)) phone = `254${phone}`;
    if (!/^254[17]\d{8}$/.test(phone)) throw new BadRequestException('Use a Kenyan mobile number, e.g. 0712345678');
    return phone;
  }

  private async accessToken(base: string): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt - 60000) return this.cachedToken;
    const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
    let response: Response;
    try {
      response = await fetch(`${base}/oauth/v1/generate?grant_type=client_credentials`, {
        headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new ServiceUnavailableException('Could not reach M-Pesa authentication service');
    }
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) throw new ServiceUnavailableException('M-Pesa authentication failed; check your Daraja credentials');
    this.cachedToken = data.access_token;
    this.tokenExpiresAt = Date.now() + Math.max(60, Number(data.expires_in ?? 3600)) * 1000;
    return this.cachedToken!;
  }

  async initiate(input: { phone: string; amount: number; purpose: Purpose; paymentId: string }): Promise<string> {
    const cfg = this.config();
    const token = await this.accessToken(cfg.base);
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date());
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const timestamp = `${part('year')}${part('month')}${part('day')}${part('hour')}${part('minute')}${part('second')}`;
    const password = Buffer.from(`${cfg.shortcode}${cfg.passkey}${timestamp}`).toString('base64');
    const payload = {
      BusinessShortCode: cfg.shortcode, Password: password, Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline', Amount: input.amount,
      PartyA: input.phone, PartyB: cfg.shortcode, PhoneNumber: input.phone,
      CallBackURL: cfg.callbackUrl, AccountReference: `SW${input.paymentId.replace(/-/g, '').slice(0, 8)}`,
      TransactionDesc: input.purpose === 'subscription' ? 'SWASS plan' : 'SWASS wallet',
    };
    let response: Response;
    try {
      response = await fetch(`${cfg.base}/mpesa/stkpush/v1/processrequest`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(25000),
      });
    } catch {
      throw new ServiceUnavailableException('M-Pesa request timed out or could not be reached. Check payment status before retrying.');
    }
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok || data.ResponseCode !== '0' || !data.CheckoutRequestID) {
      throw new HttpException(data.errorMessage ?? data.ResponseDescription ?? 'M-Pesa did not accept the payment request', HttpStatus.BAD_GATEWAY);
    }
    return String(data.CheckoutRequestID);
  }

  validCallbackToken(candidate: string): boolean {
    const expected = process.env.MPESA_CALLBACK_TOKEN ?? '';
    if (!expected || !candidate || candidate.length > 256) return false;
    return timingSafeEqual(createHash('sha256').update(candidate).digest(), createHash('sha256').update(expected).digest());
  }
}

@Controller('api/v1/mpesa')
export class MpesaController {
  constructor(private db: DbService, private mpesa: MpesaService) {}

  @Post('stk-push')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('owner', 'manager')
  async stkPush(@Req() req: any, @Body() body: any) {
    const tenantId = req.user?.tenantId;
    if (!tenantId) throw new ForbiddenException();
    const purpose: Purpose = body?.purpose;
    if (!['subscription', 'wallet_topup'].includes(purpose)) throw new BadRequestException('purpose must be subscription or wallet_topup');
    const phone = this.mpesa.normalizePhone(body?.phone);
    let amount: number;
    if (purpose === 'subscription') {
      if (!['monthly', 'yearly'].includes(body?.plan)) throw new BadRequestException('Choose monthly or yearly subscription');
      amount = body.plan === 'monthly' ? MONTHLY_KES : YEARLY_KES;
    } else {
      amount = Number(body?.amountKes);
      if (!Number.isSafeInteger(amount) || amount < 10 || amount > MAX_TOPUP_KES) {
        throw new BadRequestException(`Wallet top-up must be between KSh 10 and KSh ${MAX_TOPUP_KES.toLocaleString('en-KE')}`);
      }
    }

    const inserted = await this.db.pool.query(
      `INSERT INTO payments (tenant_id, purpose, amount_kes, phone, status) VALUES ($1,$2,$3,$4,'pending') RETURNING id`,
      [tenantId, purpose, amount, phone],
    );
    const paymentId: string = inserted.rows[0].id;
    try {
      const checkoutId = await this.mpesa.initiate({ phone, amount, purpose, paymentId });
      await this.db.pool.query(`UPDATE payments SET checkout_request_id=$1 WHERE id=$2 AND tenant_id=$3`, [checkoutId, paymentId, tenantId]);
      return { paymentId, status: 'pending', amountKes: amount, phone, message: 'STK prompt requested. Complete the prompt on your phone; payment is not confirmed until the callback is received.' };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '';
      if (!(error instanceof ServiceUnavailableException && errorMessage.includes('timed out'))) {
        await this.db.pool.query(`UPDATE payments SET status='failed' WHERE id=$1 AND status='pending'`, [paymentId]);
      }
      throw error;
    }
  }

  @Get('payments/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('owner', 'manager')
  async paymentStatus(@Req() req: any, @Param('id') id: string) {
    if (!req.user?.tenantId) throw new ForbiddenException();
    const result = await this.db.pool.query(
      `SELECT id, purpose, amount_kes, phone, status, mpesa_receipt_no, created_at FROM payments WHERE id=$1 AND tenant_id=$2`,
      [id, req.user.tenantId],
    );
    if (!result.rowCount) throw new HttpException('Payment not found', HttpStatus.NOT_FOUND);
    const p = result.rows[0];
    return { id: p.id, purpose: p.purpose, amountKes: Number(p.amount_kes), phone: p.phone, status: p.status, receiptNumber: p.mpesa_receipt_no, createdAt: p.created_at };
  }

  @Post('callback/:token')
  async callback(@Param('token') token: string, @Body() body: any) {
    if (!this.mpesa.validCallbackToken(token)) return { ResultCode: 0, ResultDesc: 'Accepted' };
    const cb = body?.Body?.stkCallback;
    if (!cb?.CheckoutRequestID || !Number.isInteger(Number(cb.ResultCode))) return { ResultCode: 0, ResultDesc: 'Accepted' };
    const items: any[] = Array.isArray(cb.CallbackMetadata?.Item) ? cb.CallbackMetadata.Item : [];
    const metadata = Object.fromEntries(items.map((item) => [item.Name, item.Value]));
    const successful = Number(cb.ResultCode) === 0;
    const receipt = successful && typeof metadata.MpesaReceiptNumber === 'string' ? metadata.MpesaReceiptNumber : null;
    const amount = successful ? Number(metadata.Amount) : null;
    const phone = successful ? String(metadata.PhoneNumber ?? '') : null;
    try {
      await this.db.tx(async (c) => {
        const found = await c.query(`SELECT * FROM payments WHERE checkout_request_id=$1 FOR UPDATE`, [String(cb.CheckoutRequestID)]);
        if (!found.rowCount) return;
        const p = found.rows[0];
        if (p.status !== 'pending') return;
        if (!successful) {
          await c.query(`UPDATE payments SET status='failed' WHERE id=$1`, [p.id]);
          return;
        }
        const normalizedPhone = phone && /^254[17]\d{8}$/.test(phone) ? phone : null;
        if (!receipt || !Number.isSafeInteger(amount) || amount !== Number(p.amount_kes) || normalizedPhone !== p.phone) return;
        await c.query(`UPDATE payments SET status='success', mpesa_receipt_no=$1 WHERE id=$2`, [receipt, p.id]);
        if (p.purpose === 'wallet_topup') {
          const wallet = await c.query(`UPDATE wallets SET balance_kes=balance_kes+$1 WHERE tenant_id=$2`, [p.amount_kes, p.tenant_id]);
          if (!wallet.rowCount) throw new Error('Wallet not found for successful top-up');
          await c.query(`INSERT INTO wallet_transactions (tenant_id, change_kes, reason, payment_id) VALUES ($1,$2,'topup',$3)`, [p.tenant_id, p.amount_kes, p.id]);
        } else {
          const plan = Number(p.amount_kes) === YEARLY_KES ? 'yearly' : 'monthly';
          const interval = plan === 'yearly' ? '1 year' : '1 month';
          await c.query(
            `INSERT INTO subscriptions (tenant_id, plan, price_kes, starts_at, ends_at, status, auto_renew)
             VALUES ($1,$2,$3,COALESCE((SELECT MAX(ends_at) FROM subscriptions WHERE tenant_id=$1 AND status='active' AND ends_at>now()),now()),COALESCE((SELECT MAX(ends_at) FROM subscriptions WHERE tenant_id=$1 AND status='active' AND ends_at>now()),now())+$4::interval,'active',false)`, [p.tenant_id, plan, p.amount_kes, interval],
          );
        }
      });
    } catch {
      // Acknowledge Daraja; failed internal processing leaves the payment pending for reconciliation.
    }
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }
}
