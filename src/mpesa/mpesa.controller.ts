import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpException,
  HttpStatus, Injectable, Param, Post, Req, ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { DbService } from '../db/db.service';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { IntaSendService } from '../intasend/intasend.service';

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
  constructor(private db: DbService, private mpesa: MpesaService, private intasend: IntaSendService) {}

  @Get('account-summary')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('owner', 'manager', 'freelancer')
  async accountSummary(@Req() req: any) {
    if (req.user?.role === 'freelancer') {
      await this.db.ensureFreelancerSubscriptionSchema();
      const personal = await this.db.pool.query(`SELECT plan,status,starts_at,ends_at FROM freelancer_subscriptions
        WHERE user_id=$1 ORDER BY ends_at DESC LIMIT 1`, [req.user.sub]);
      const sub = personal.rows[0];
      return { subscription: sub ? { plan: sub.plan, status: sub.status, startsAt: sub.starts_at, endsAt: sub.ends_at,
        active: sub.status === 'active' && new Date(sub.ends_at).getTime() > Date.now() } : null,
        balanceKes: 0, receiptFeeKes: 4, receiptsRemaining: 0, walletRemainderKes: 0, subscriberType: 'freelancer' };
    }
    const tenantId = req.user?.tenantId;
    if (!tenantId) throw new ForbiddenException();
    const [subscription, trial, wallet] = await Promise.all([
      this.db.pool.query(`SELECT plan,status,starts_at,ends_at FROM subscriptions
        WHERE tenant_id=$1 ORDER BY ends_at DESC LIMIT 1`, [tenantId]),
      this.db.pool.query(`SELECT starts_at,ends_at FROM subscription_trials
        WHERE tenant_id=$1 AND ends_at>now() ORDER BY ends_at DESC LIMIT 1`, [tenantId]),
      this.db.pool.query(`SELECT balance_kes FROM wallets WHERE tenant_id=$1 LIMIT 1`, [tenantId]),
    ]);
    const balanceKes = Number(wallet.rows[0]?.balance_kes ?? 0);
    const receiptFeeKes = 4;
    const paidSubscription = subscription.rows[0] ?? null;
    const activeTrial = trial.rows[0] ?? null;
    return {
      subscription: paidSubscription ? {
        plan: paidSubscription.plan, status: paidSubscription.status,
        startsAt: paidSubscription.starts_at, endsAt: paidSubscription.ends_at,
        active: paidSubscription.status === 'active' && new Date(paidSubscription.ends_at).getTime() > Date.now()
      } : activeTrial ? {
        plan: 'trial', status: 'active', startsAt: activeTrial.starts_at, endsAt: activeTrial.ends_at,
        active: true, trial: true,
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
    const isFreelancerSubscription = req.user?.role === 'freelancer' && purpose === 'subscription';
    if (!['owner', 'manager'].includes(req.user?.role) && purpose !== 'receipt_sale' && !isFreelancerSubscription) {
      throw new ForbiddenException('Freelancers may only pay their own personal subscription. Other account payments are reserved for business owners or managers.');
    }
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

    if (isFreelancerSubscription) await this.db.ensureFreelancerSubscriptionSchema();
    const inserted = await this.db.pool.query(
      `INSERT INTO payments (tenant_id, subscriber_user_id, purpose, amount_kes, phone, status)
       VALUES ($1,$2,$3,$4,$5,'pending') RETURNING id`,
      [tenantId, isFreelancerSubscription ? req.user.sub : null, purpose, amount, phone],
    );
    const paymentId: string = inserted.rows[0].id;
    if (purpose === 'vendor_fee') await this.db.pool.query(`INSERT INTO vendor_invitation_fees(tenant_id,invitation_id,payment_id,status) VALUES($1,$2,$3,'pending') ON CONFLICT(invitation_id) DO UPDATE SET payment_id=EXCLUDED.payment_id,status='pending',paid_at=NULL`, [tenantId,String(body.invitationId),paymentId]);
    try {
      if (purpose === 'subscription' && (process.env.PAYMENT_PROVIDER ?? 'tuma').trim().toLowerCase() === 'intasend') {
        const invoiceId = await this.intasend.initiate({ phone, amount, paymentId });
        await this.db.pool.query(`UPDATE payments SET checkout_request_id=$1 WHERE id=$2 AND tenant_id=$3`, [invoiceId, paymentId, tenantId]);
        return { paymentId, status: 'pending', amountKes: amount, phone, provider: 'intasend', invoiceId, message: 'IntaSend M-Pesa prompt requested. Complete the prompt on your phone; your subscription activates only after IntaSend confirms payment.' };
      }
      const checkoutId = await this.mpesa.initiate({ phone, amount, purpose, paymentId });
      await this.db.pool.query(`UPDATE payments SET checkout_request_id=$1 WHERE id=$2 AND tenant_id=$3`, [checkoutId, paymentId, tenantId]);
      return { paymentId, status: 'pending', amountKes: amount, phone, provider: 'tuma', message: 'Tuma STK prompt requested. Complete the prompt on your phone; the subscription activates only after Tuma confirms payment.' };
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
    const result = req.user?.role === 'freelancer'
      ? await this.db.pool.query(
          `SELECT id, purpose, amount_kes, phone, status, mpesa_receipt_no, created_at FROM payments WHERE id=$1 AND tenant_id=$2 AND subscriber_user_id=$3`,
          [id, req.user.tenantId, req.user.sub],
        )
      : await this.db.pool.query(
          `SELECT id, purpose, amount_kes, phone, status, mpesa_receipt_no, created_at FROM payments WHERE id=$1 AND tenant_id=$2`,
          [id, req.user.tenantId],
        );
    if (!result.rowCount) throw new HttpException('Payment not found', HttpStatus.NOT_FOUND);
    const p = result.rows[0];
    return { id: p.id, purpose: p.purpose, amountKes: Number(p.amount_kes), phone: p.phone, status: p.status, receiptNumber: p.mpesa_receipt_no, createdAt: p.created_at };
  }

  // Customer fallback: record an M-Pesa receipt code against their latest unresolved subscription payment.
  // This never activates a plan. A super-admin must verify the transaction with Tuma/M-Pesa first.
  @Post('subscription-receipt-claim')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('owner', 'manager', 'freelancer')
  async submitSubscriptionReceiptClaim(@Req() req: any, @Body() body: any) {
    const tenantId = req.user?.tenantId;
    if (!tenantId) throw new ForbiddenException();
    const receipt = String(body?.receiptNumber || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6,24}$/.test(receipt)) throw new BadRequestException('Enter the exact M-Pesa transaction code from the confirmation SMS.');
    const phone = this.mpesa.normalizePhone(String(body?.phone || ''));
    await this.db.ensureFreelancerSubscriptionSchema();
    await this.db.pool.query(`CREATE TABLE IF NOT EXISTS subscription_payment_receipt_claims (
      id BIGSERIAL PRIMARY KEY,
      payment_id UUID NOT NULL UNIQUE REFERENCES payments(id) ON DELETE CASCADE,
      tenant_id UUID NOT NULL,
      user_id UUID NOT NULL,
      receipt_number TEXT NOT NULL UNIQUE,
      payer_phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','verified','rejected')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (receipt_number)
    )`);
    const freelancer = req.user?.role === 'freelancer';
    const found = await this.db.pool.query(
      `SELECT id,amount_kes,phone,status FROM payments
        WHERE tenant_id=$1 AND purpose='subscription'
          AND status IN ('pending','failed')
          AND subscriber_user_id IS NOT DISTINCT FROM $2
          AND phone=$3
        ORDER BY created_at DESC LIMIT 1`,
      [tenantId, freelancer ? req.user.sub : null, phone],
    );
    if (!found.rowCount) throw new BadRequestException('No matching unpaid subscription request was found for this account and phone number. Start a subscription request first, or contact AURORA support if you already paid.');
    try {
      await this.db.pool.query(
        `INSERT INTO subscription_payment_receipt_claims(payment_id,tenant_id,user_id,receipt_number,payer_phone)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(payment_id) DO UPDATE SET receipt_number=EXCLUDED.receipt_number,payer_phone=EXCLUDED.payer_phone,status='pending_review',created_at=now()`,
        [found.rows[0].id,tenantId,req.user.sub,receipt,phone],
      );
    } catch (error: any) {
      if (error?.code === '23505') throw new BadRequestException('That M-Pesa transaction code has already been submitted. Contact AURORA support if you believe this is an error.');
      throw error;
    }
    return { submitted:true, status:'pending_review', paymentId:found.rows[0].id,
      amountKes:Number(found.rows[0].amount_kes),
      message:'Your M-Pesa code has been submitted for verification. Your subscription will activate after AURORA confirms the transaction. Do not pay again while it is being checked.' };
  }

  @Post('callback/:token')
  async callback(@Param('token') token: string, @Body() body: any) {
    if (!this.mpesa.validCallbackToken(token)) {
      console.warn('[AURORA][PAYMENT] Callback rejected: invalid callback token');
      return { ResultCode: 0, ResultDesc: 'Accepted' };
    }
    const checkoutId = body?.checkout_request_id;
    const status = String(body?.status ?? '').toLowerCase();
    console.info('[AURORA][PAYMENT] Callback received', {
      checkoutId: typeof checkoutId === 'string' ? checkoutId.slice(0, 48) : 'missing',
      status: status || 'missing', resultCode: body?.result_code ?? 'missing',
      amount: body?.amount ?? 'missing',
      hasReceipt: typeof body?.mpesa_receipt_number === 'string' && !!body.mpesa_receipt_number.trim(),
    });
    if (typeof checkoutId !== 'string' || !checkoutId) {
      console.warn('[AURORA][PAYMENT] Callback ignored: checkout_request_id missing');
      return { ResultCode: 0, ResultDesc: 'Accepted' };
    }
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
        if (!found.rowCount) {
          console.warn('[AURORA][PAYMENT] Callback checkout ID not found in payments table', { checkoutId: checkoutId.slice(0, 48) });
          return;
        }
        const p = found.rows[0];
        console.info('[AURORA][PAYMENT] Matched payment', { paymentId: String(p.id), purpose: p.purpose, currentStatus: p.status, amountKes: Number(p.amount_kes) });
        if (p.status !== 'pending') return;
        if (status !== 'completed' || Number(body?.result_code) !== 0) {
          if (status === 'failed') await c.query(`UPDATE payments SET status='failed' WHERE id=$1 AND status='pending'`, [p.id]);
          return;
        }
        const receipt = typeof body?.mpesa_receipt_number === 'string' ? body.mpesa_receipt_number.trim() : '';
        const amount = Number(body?.amount);
        const callbackPhoneRaw = typeof body?.phone === 'string' ? body.phone : '';
        const canonicalPhone = (value: string) => {
          let digits = value.replace(/\D/g, '');
          if (digits.startsWith('0') && digits.length === 10) digits = '254' + digits.slice(1);
          if (/^[17]\d{8}$/.test(digits)) digits = '254' + digits;
          return /^254[17]\d{8}$/.test(digits) ? digits : '';
        };
        const callbackPhone = canonicalPhone(callbackPhoneRaw);
        if (!receipt || !Number.isSafeInteger(amount) || amount !== Number(p.amount_kes)) {
          console.warn('[AURORA][PAYMENT] Successful callback failed receipt/amount validation', {
            paymentId: String(p.id), hasReceipt: !!receipt,
            callbackAmount: Number.isFinite(amount) ? amount : 'invalid', expectedAmount: Number(p.amount_kes),
          });
          return;
        }
        // Tuma may send 07..., 01..., 2547... or +2547... for the same payer.
        if (callbackPhoneRaw && (!callbackPhone || callbackPhone !== canonicalPhone(String(p.phone)))) return;

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
          if (p.subscriber_user_id) {
            await c.query(
              `INSERT INTO freelancer_subscriptions (user_id,payment_id,plan,price_kes,starts_at,ends_at,status)
               VALUES ($1,$2,$3,$4,
                 COALESCE((SELECT MAX(ends_at) FROM freelancer_subscriptions WHERE user_id=$1 AND status='active' AND ends_at>now()),now()),
                 COALESCE((SELECT MAX(ends_at) FROM freelancer_subscriptions WHERE user_id=$1 AND status='active' AND ends_at>now()),now())+$5::interval,
                 'active')`,
              [p.subscriber_user_id,p.id,plan,p.amount_kes,interval],
            );
          } else {
            await c.query(
              `INSERT INTO subscriptions (tenant_id, plan, price_kes, starts_at, ends_at, status, auto_renew)
               VALUES ($1,$2,$3,COALESCE((SELECT MAX(ends_at) FROM subscriptions WHERE tenant_id=$1 AND status='active' AND ends_at>now()),now()),COALESCE((SELECT MAX(ends_at) FROM subscriptions WHERE tenant_id=$1 AND status='active' AND ends_at>now()),now())+$4::interval,'active',false)`,
              [p.tenant_id, plan, p.amount_kes, interval],
            );
          }
          const firstSubscription = await c.query(
            `SELECT COUNT(*)::int AS paid_count FROM payments
              WHERE tenant_id=$1 AND purpose='subscription' AND status='success' AND subscriber_user_id IS NULL`, [p.tenant_id],
          );
          if (!p.subscriber_user_id && Number(firstSubscription.rows[0].paid_count) === 1) {
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
    } catch (error) {
      console.error('[AURORA][PAYMENT] Callback database processing failed; transaction rolled back', {
        message: error instanceof Error ? error.message : 'Unknown database error',
      });
    }
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }
}
