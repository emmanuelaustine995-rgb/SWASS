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
type Purpose = 'subscription' | 'wallet_topup' | 'recovery' | 'vendor_fee' | 'receipt_sale' | 'second_hand_recovery';

@Injectable()
export class MpesaService {
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  private config() {
    // Render secrets can contain copied quotes, invisible characters, or a pasted
    // "Bearer " prefix. Normalize these safely before sending credentials to Tuma.
    const cleanEnv = (value?: string) => (value ?? '')
      .replace(/^\uFEFF/, '')
      .replace(/[\u200B-\u200D\u2060]/g, '')
      .trim()
      .replace(/^(['"])(.*)\1$/s, '$2');
    const email = cleanEnv(process.env.TUMA_BUSINESS_EMAIL).toLowerCase();
    const apiKey = cleanEnv(process.env.TUMA_API_KEY)
      .replace(/^Bearer\s+/i, '')
      .replace(/\s+/g, '');
    if (!email || !apiKey) {
      throw new ServiceUnavailableException('Tuma Payments is not configured. Add TUMA_BUSINESS_EMAIL and TUMA_API_KEY in Render.');
    }
    const callbackToken = process.env.MPESA_CALLBACK_TOKEN ?? '';
    if (!callbackToken) throw new ServiceUnavailableException('Payment callback security token is not configured');
    return {
      email,
      apiKey,
      base: 'https://api.tuma.co.ke',
      callbackUrl: `https://swass-api.onrender.com/api/v1/mpesa/callback/${encodeURIComponent(callbackToken)}`,
    };
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

  private async accessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt - 60000) return this.cachedToken;
    const cfg = this.config();
    let response: Response;
    try {
      response = await fetch(`${cfg.base}/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: cfg.email, api_key: cfg.apiKey }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new ServiceUnavailableException('Could not reach Tuma Payments authentication service');
    }
    const data: any = await response.json().catch(() => ({}));
    const token = data?.data?.token ?? data?.token;
    if (!response.ok || data?.success !== true || typeof token !== 'string' || !token) {
      // Log only Tuma's status and non-secret diagnostic fields. Never log the API key or token.
      console.error('[SWASS Tuma auth failed]', {
        httpStatus: response.status,
        message: typeof data?.message === 'string' ? data.message : 'No message returned',
        errorCode: typeof data?.error_code === 'string' ? data.error_code : undefined,
        success: data?.success,
      });
      const message = typeof data?.message === 'string' && data.message
        ? data.message
        : 'Tuma authentication failed. Check that the API key and business-profile email belong to the same selected business.';
      throw new ServiceUnavailableException(`Tuma authentication failed (HTTP ${response.status}): ${message}`);
    }
    this.cachedToken = token;
    // Tuma tokens are short-lived; refresh conservatively after 20 minutes.
    this.tokenExpiresAt = Date.now() + 20 * 60 * 1000;
    return token;
  }

  async initiate(input: { phone: string; amount: number; purpose: Purpose; paymentId: string }): Promise<string> {
    const cfg = this.config();
    const token = await this.accessToken();
    let response: Response;
    try {
      response = await fetch(`${cfg.base}/payment/stk-push`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: input.amount,
          phone: input.phone,
          callback_url: cfg.callbackUrl,
          description: input.purpose === 'subscription' ? `SWASS subscription ${input.paymentId}` : input.purpose === 'recovery' ? `SWASS receipt recovery ${input.paymentId}` : input.purpose === 'vendor_fee' ? `AURORA vendor activation ${input.paymentId}` : input.purpose === 'second_hand_recovery' ? `AURORA Special Receipt recovery ${input.paymentId}` : `SWASS wallet top-up ${input.paymentId}`,
        }),
        signal: AbortSignal.timeout(25000),
      });
    } catch {
      throw new ServiceUnavailableException('Tuma payment request timed out or could not be reached. Check payment status before retrying.');
    }
    const data: any = await response.json().catch(() => ({}));
    const checkoutId = data?.data?.checkout_request_id;
    if (!response.ok || data?.success !== true || typeof checkoutId !== 'string' || !checkoutId) {
      throw new HttpException(data?.message ?? 'Tuma did not accept the payment request', HttpStatus.BAD_GATEWAY);
    }
    return checkoutId;
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

  @Get('account-summary')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('owner', 'manager')
  async accountSummary(@Req() req: any) {
    const tenantId = req.user?.tenantId;
    if (!tenantId) throw new ForbiddenException();
    const [subscription, wallet] = await Promise.all([
      this.db.pool.query(`SELECT plan,status,starts_at,ends_at FROM subscriptions
        WHERE tenant_id=$1 ORDER BY ends_at DESC LIMIT 1`, [tenantId]),
      this.db.pool.query(`SELECT balance_kes FROM wallets WHERE tenant_id=$1 LIMIT 1`, [tenantId]),
    ]);
    const balanceKes = Number(wallet.rows[0]?.balance_kes ?? 0);
    const receiptFeeKes = 4;
    return {
      subscription: subscription.rows[0] ? {
        plan: subscription.rows[0].plan, status: subscription.rows[0].status,
        startsAt: subscription.rows[0].starts_at, endsAt: subscription.rows[0].ends_at,
        active: subscription.rows[0].status === 'active' && new Date(subscription.rows[0].ends_at).getTime() > Date.now()
      } : null,
      balanceKes, receiptFeeKes,
      receiptsRemaining: Math.floor(balanceKes / receiptFeeKes),
      walletRemainderKes: balanceKes % receiptFeeKes
    };
  }

  @Post('stk-push')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('owner', 'manager', 'cashier', 'vendor', 'freelancer')
  async stkPush(@Req() req: any, @Body() body: any) {
    const tenantId = req.user?.tenantId;
    if (!tenantId) throw new ForbiddenException();
    const purpose: Purpose = body?.purpose;
    if (!['owner', 'manager'].includes(req.user?.role) && purpose !== 'receipt_sale') throw new ForbiddenException('Only business owners or managers can make account payments.');
    if (!['subscription', 'wallet_topup', 'vendor_fee', 'receipt_sale'].includes(purpose)) throw new BadRequestException('Invalid payment purpose');
    const phone = this.mpesa.normalizePhone(body?.phone);
    let amount: number;
    if (purpose === 'vendor_fee') {
      const invite = await this.db.pool.query(`SELECT id FROM staff_email_invitations WHERE id=$1 AND tenant_id=$2 AND store_id=$3 AND job_title='Vendor' AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()`, [String(body?.invitationId||''), tenantId, req.user.storeId]);
      if (!invite.rowCount) throw new BadRequestException('Active vendor invitation not found.');
      const old = await this.db.pool.query(`SELECT status FROM vendor_invitation_fees WHERE invitation_id=$1`, [String(body.invitationId)]);
      if (old.rows[0]?.status === 'paid') throw new BadRequestException('Vendor activation fee already paid.');
      amount = 50;
    } else if (purpose === 'subscription') {
      if (!['monthly', 'yearly'].includes(body?.plan)) throw new BadRequestException('Choose monthly or yearly subscription');
      amount = body.plan === 'monthly' ? MONTHLY_KES : YEARLY_KES;
    } else {
      amount = Number(body?.amountKes);
      const minimum = purpose === 'receipt_sale' ? 1 : 4;
      if (!Number.isSafeInteger(amount) || amount < minimum || amount > MAX_TOPUP_KES) {
        throw new BadRequestException(purpose === 'receipt_sale'
          ? `Receipt payment must be between KSh 1 and KSh ${MAX_TOPUP_KES.toLocaleString('en-KE')}`
          : `Wallet top-up must be between KSh 4 and KSh ${MAX_TOPUP_KES.toLocaleString('en-KE')}`);
      }
    }

    const inserted = await this.db.pool.query(
      `INSERT INTO payments (tenant_id, purpose, amount_kes, phone, status) VALUES ($1,$2,$3,$4,'pending') RETURNING id`,
      [tenantId, purpose, amount, phone],
    );
    const paymentId: string = inserted.rows[0].id;
    if (purpose === 'vendor_fee') await this.db.pool.query(`INSERT INTO vendor_invitation_fees(tenant_id,invitation_id,payment_id,status) VALUES($1,$2,$3,'pending') ON CONFLICT(invitation_id) DO UPDATE SET payment_id=EXCLUDED.payment_id,status='pending',paid_at=NULL`, [tenantId,String(body.invitationId),paymentId]);
    try {
      const checkoutId = await this.mpesa.initiate({ phone, amount, purpose, paymentId });
      await this.db.pool.query(`UPDATE payments SET checkout_request_id=$1 WHERE id=$2 AND tenant_id=$3`, [checkoutId, paymentId, tenantId]);
      return { paymentId, status: 'pending', amountKes: amount, phone, message: 'Tuma STK prompt requested. Complete the prompt on your phone; the subscription activates only after Tuma confirms payment.' };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '';
      if (!(error instanceof ServiceUnavailableException && errorMessage.toLowerCase().includes('timed out'))) {
        await this.db.pool.query(`UPDATE payments SET status='failed' WHERE id=$1 AND status='pending'`, [paymentId]);
      }
      throw error;
    }
  }

  @Get('payments/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('owner', 'manager', 'cashier', 'vendor', 'freelancer')
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
    const checkoutId = body?.checkout_request_id;
    const status = String(body?.status ?? '').toLowerCase();
    if (typeof checkoutId !== 'string' || !checkoutId) return { ResultCode: 0, ResultDesc: 'Accepted' };
    try {
      await this.db.tx(async (c) => {
        const special = await c.query(`SELECT * FROM second_hand_special_receipt_recoveries WHERE checkout_request_id=$1 FOR UPDATE`, [checkoutId]);
        if (special.rowCount) {
          const sp = special.rows[0];
          if (sp.status !== 'pending') return;
          if (status !== 'completed' || Number(body?.result_code) !== 0) {
            if (status === 'failed') await c.query(`UPDATE second_hand_special_receipt_recoveries SET status='failed' WHERE id=$1 AND status='pending'`, [sp.id]);
            return;
          }
          const specialReceipt = typeof body?.mpesa_receipt_number === 'string' ? body.mpesa_receipt_number.trim() : '';
          const specialAmount = Number(body?.amount);
          const specialPhone = typeof body?.phone === 'string' ? body.phone.replace(/^\\+/, '') : '';
          if (!specialReceipt || !Number.isSafeInteger(specialAmount) || specialAmount !== 50) return;
          if (specialPhone && specialPhone !== sp.phone) return;
          await c.query(`UPDATE second_hand_special_receipt_recoveries SET status='success',mpesa_receipt_no=$1,paid_at=now() WHERE id=$2 AND status='pending'`, [specialReceipt, sp.id]);
          return;
        }
        const recovery = await c.query(`SELECT * FROM receipt_recovery_payments WHERE checkout_request_id=$1 FOR UPDATE`, [checkoutId]);
        if (recovery.rowCount) {
          const rp = recovery.rows[0];
          if (rp.status !== 'pending') return;
          if (status !== 'completed' || Number(body?.result_code) !== 0) {
            if (status === 'failed') await c.query(`UPDATE receipt_recovery_payments SET status='failed' WHERE id=$1 AND status='pending'`, [rp.id]);
            return;
          }
          const recoveryReceipt = typeof body?.mpesa_receipt_number === 'string' ? body.mpesa_receipt_number.trim() : '';
          const recoveryAmount = Number(body?.amount);
          const recoveryPhone = typeof body?.phone === 'string' ? body.phone.replace(/^\+/, '') : '';
          if (!recoveryReceipt || !Number.isSafeInteger(recoveryAmount) || recoveryAmount !== Number(rp.amount_kes)) return;
          if (recoveryPhone && recoveryPhone !== rp.phone) return;
          await c.query(`UPDATE receipt_recovery_payments SET status='success',mpesa_receipt_no=$1,paid_at=now() WHERE id=$2 AND status='pending'`, [recoveryReceipt, rp.id]);
          return;
        }
        const found = await c.query(`SELECT * FROM payments WHERE checkout_request_id=$1 FOR UPDATE`, [checkoutId]);
        if (!found.rowCount) return;
        const p = found.rows[0];
        if (p.status !== 'pending') return;
        if (status !== 'completed' || Number(body?.result_code) !== 0) {
          if (status === 'failed') await c.query(`UPDATE payments SET status='failed' WHERE id=$1 AND status='pending'`, [p.id]);
          return;
        }
        const receipt = typeof body?.mpesa_receipt_number === 'string' ? body.mpesa_receipt_number.trim() : '';
        const amount = Number(body?.amount);
        const callbackPhone = typeof body?.phone === 'string' ? body.phone.replace(/^\+/, '') : '';
        if (!receipt || !Number.isSafeInteger(amount) || amount !== Number(p.amount_kes)) return;
        if (callbackPhone && callbackPhone !== p.phone) return;

        await c.query(`UPDATE payments SET status='success', mpesa_receipt_no=$1 WHERE id=$2 AND status='pending'`, [receipt, p.id]);
        if (p.purpose === 'vendor_fee') {
          await c.query(`UPDATE vendor_invitation_fees SET status='paid',paid_at=now() WHERE payment_id=$1 AND status='pending'`, [p.id]);
          const referral = await c.query('SELECT referrer_tenant_id FROM tenant_referrals WHERE referred_tenant_id=$1 AND referrer_tenant_id<>$1', [p.tenant_id]);
          if (referral.rowCount) {
            const referrerTenantId=referral.rows[0].referrer_tenant_id;
            const referralAmount=Math.floor(Number(p.amount_kes)*0.5);
            await c.query(`INSERT INTO referral_commissions(referrer_tenant_id,referred_tenant_id,payment_id,commission_type,amount_kes)
              VALUES($1,$2,$3,'vendor_activation',$4) ON CONFLICT(payment_id) DO NOTHING`,
              [referrerTenantId,p.tenant_id,p.id,referralAmount]);
            await c.query(`INSERT INTO platform_payment_splits(payment_id,tenant_id,payment_purpose,gross_amount_kes,company_amount_kes,referral_amount_kes,referrer_tenant_id)
              VALUES($1,$2,'vendor_fee',$3,$4,$5,$6) ON CONFLICT(payment_id) DO NOTHING`,
              [p.id,p.tenant_id,p.amount_kes,Number(p.amount_kes)-referralAmount,referralAmount,referrerTenantId]);
          }
        } else if (p.purpose === 'subscription') {
          await c.query(
            `INSERT INTO platform_financial_ledger (tenant_id, payment_id, entry_type, amount_kes, external_reference)
             VALUES ($1, $2, 'subscription_revenue', $3, $4)`,
            [p.tenant_id, p.id, p.amount_kes, receipt],
          );
          const plan = Number(p.amount_kes) === YEARLY_KES ? 'yearly' : 'monthly';
          const interval = plan === 'yearly' ? '1 year' : '1 month';
          await c.query(
            `INSERT INTO subscriptions (tenant_id, plan, price_kes, starts_at, ends_at, status, auto_renew)
             VALUES ($1,$2,$3,COALESCE((SELECT MAX(ends_at) FROM subscriptions WHERE tenant_id=$1 AND status='active' AND ends_at>now()),now()),COALESCE((SELECT MAX(ends_at) FROM subscriptions WHERE tenant_id=$1 AND status='active' AND ends_at>now()),now())+$4::interval,'active',false)`,
            [p.tenant_id, plan, p.amount_kes, interval],
          );
          const firstSubscription = await c.query(
            `SELECT COUNT(*)::int AS paid_count FROM payments
              WHERE tenant_id=$1 AND purpose='subscription' AND status='success'`, [p.tenant_id],
          );
          if (Number(firstSubscription.rows[0].paid_count) === 1) {
            const referral = await c.query('SELECT referrer_tenant_id FROM tenant_referrals WHERE referred_tenant_id=$1 AND referrer_tenant_id<>$1 FOR UPDATE', [p.tenant_id]);
            if (referral.rowCount) {
              const referrerTenantId=referral.rows[0].referrer_tenant_id;
              const referralAmount=Math.floor(Number(p.amount_kes)*0.5);
              await c.query(
                `INSERT INTO referral_rewards(referrer_tenant_id,referred_tenant_id,payment_id,amount_kes)
                 VALUES($1,$2,$3,$4) ON CONFLICT (referred_tenant_id) DO NOTHING`,
                [referrerTenantId,p.tenant_id,p.id,referralAmount],
              );
              await c.query(`INSERT INTO platform_payment_splits(payment_id,tenant_id,payment_purpose,gross_amount_kes,company_amount_kes,referral_amount_kes,referrer_tenant_id)
                VALUES($1,$2,'subscription',$3,$4,$5,$6) ON CONFLICT(payment_id) DO NOTHING`,
                [p.id,p.tenant_id,p.amount_kes,Number(p.amount_kes)-referralAmount,referralAmount,referrerTenantId]);
            }
          }
        } else if (p.purpose === 'wallet_topup') {
          const wallet = await c.query(`UPDATE wallets SET balance_kes=balance_kes+$1 WHERE tenant_id=$2`, [p.amount_kes, p.tenant_id]);
          if (!wallet.rowCount) throw new Error('Wallet not found for successful top-up');
          await c.query(`INSERT INTO wallet_transactions (tenant_id, change_kes, reason, payment_id) VALUES ($1,$2,'topup',$3)`, [p.tenant_id, p.amount_kes, p.id]);
        }
      });
    } catch {
      // Keep failed internal processing visible as pending for safe reconciliation.
    }
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }
}
