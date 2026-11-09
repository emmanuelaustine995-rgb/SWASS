import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';

const RECEIPT_FEE_KES = 4;

@Controller('api/v1/referrals')
@UseGuards(AuthGuard, RolesGuard)
@Roles('owner')
export class ReferralsController {
  constructor(private db: DbService) {}

  @Get('summary')
  @Roles('owner')
  async summary(@Req() req: any) {
    const tenantId = req.user?.tenantId;
    if (!tenantId) throw new BadRequestException('Business owner account required');
    let result = await this.db.pool.query('SELECT referral_code FROM tenants WHERE id=$1', [tenantId]);
    if (!result.rowCount) throw new BadRequestException('Business account not found');
    if (!result.rows[0].referral_code) {
      const code = randomBytes(5).toString('hex').toUpperCase();
      await this.db.pool.query('UPDATE tenants SET referral_code=$1 WHERE id=$2 AND referral_code IS NULL', [code, tenantId]);
      result = await this.db.pool.query('SELECT referral_code FROM tenants WHERE id=$1', [tenantId]);
    }
    const [counts, earned, redeemed] = await Promise.all([
      this.db.pool.query(`SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id=tr.referred_tenant_id AND s.status='active' AND s.ends_at>now()))::int AS active
        FROM tenant_referrals tr WHERE tr.referrer_tenant_id=$1`, [tenantId]),
      this.db.pool.query(`SELECT
        (SELECT COALESCE(SUM(amount_kes),0) FROM referral_rewards WHERE referrer_tenant_id=$1) +
        (SELECT COALESCE(SUM(amount_kes),0) FROM referral_commissions WHERE referrer_tenant_id=$1) AS total`, [tenantId]),
      this.db.pool.query(`SELECT (SELECT COALESCE(SUM(amount_kes),0) FROM referral_redemptions WHERE tenant_id=$1) + (SELECT COALESCE(SUM(amount_kes),0) FROM referral_withdrawal_requests WHERE tenant_id=$1 AND status IN ('pending','approved','paid')) AS total`, [tenantId]),
    ]);
    const earnedKes = Number(earned.rows[0].total || 0);
    const redeemedKes = Number(redeemed.rows[0].total || 0);
    const availableKes = Math.max(0, earnedKes - redeemedKes);
    const baseUrl = (process.env.AURORA_WEB_URL || 'https://swass-web.onrender.com').replace(/\/$/, '');
    return {
      referralCode: result.rows[0].referral_code,
      referralLink: `${baseUrl}/?ref=${encodeURIComponent(result.rows[0].referral_code)}`,
      totalReferrals: Number(counts.rows[0].total || 0),
      activeReferrals: Number(counts.rows[0].active || 0),
      earnedKes, redeemedKes, availableKes,
      availableReceipts: Math.floor(availableKes / RECEIPT_FEE_KES),
      receiptFeeKes: RECEIPT_FEE_KES,
    };
  }

  @Get('transactions')
  @Roles('owner')
  async transactions(@Req() req: any) {
    const tenantId = req.user?.tenantId;
    if (!tenantId) throw new BadRequestException('Business owner account required');
    const [rewards, commissions, redemptions] = await Promise.all([
      this.db.pool.query(`SELECT rr.id,rr.amount_kes AS "amountKes",'First subscription' AS description,rr.created_at AS "createdAt"
        FROM referral_rewards rr WHERE rr.referrer_tenant_id=$1`, [tenantId]),
      this.db.pool.query(`SELECT rc.id,rc.amount_kes AS "amountKes",
        CASE WHEN rc.commission_type='vendor_activation' THEN 'Vendor activation' ELSE 'Referral commission' END AS description,
        rc.created_at AS "createdAt" FROM referral_commissions rc WHERE rc.referrer_tenant_id=$1`, [tenantId]),
      this.db.pool.query(`SELECT id,amount_kes AS "amountKes",created_at AS "createdAt"
        FROM referral_redemptions WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 30`, [tenantId]),
    ]);
    return {
      earnings: [...rewards.rows, ...commissions.rows].sort((a,b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0,50),
      redemptions: redemptions.rows,
    };
  }

  @Post('redeem')
  @Roles('owner')
  async redeem(@Req() req: any, @Body() body: { amountKes?: number }) {
    const tenantId = req.user?.tenantId;
    if (!tenantId) throw new BadRequestException('Business owner account required');
    return this.db.tx(async c => {
      await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [tenantId]);
      const [earned, redeemed] = await Promise.all([
        c.query(`SELECT
          (SELECT COALESCE(SUM(amount_kes),0) FROM referral_rewards WHERE referrer_tenant_id=$1) +
          (SELECT COALESCE(SUM(amount_kes),0) FROM referral_commissions WHERE referrer_tenant_id=$1) AS total`, [tenantId]),
        c.query(`SELECT (SELECT COALESCE(SUM(amount_kes),0) FROM referral_redemptions WHERE tenant_id=$1) + (SELECT COALESCE(SUM(amount_kes),0) FROM referral_withdrawal_requests WHERE tenant_id=$1 AND status IN ('pending','approved','paid')) AS total`, [tenantId]),
      ]);
      const available = Number(earned.rows[0].total || 0) - Number(redeemed.rows[0].total || 0);
      if (!Number.isSafeInteger(available) || available < RECEIPT_FEE_KES) {
        throw new BadRequestException(`You need at least KSh ${RECEIPT_FEE_KES} in confirmed referral rewards to redeem a receipt credit.`);
      }
      const requested = body?.amountKes === undefined ? Math.floor(available / RECEIPT_FEE_KES) * RECEIPT_FEE_KES : Number(body.amountKes);
      if (!Number.isSafeInteger(requested) || requested < RECEIPT_FEE_KES || requested > available || requested % RECEIPT_FEE_KES !== 0) {
        throw new BadRequestException('Enter a valid redemption amount within your available referral reward balance.');
      }
      await c.query('INSERT INTO wallets(tenant_id,balance_kes) VALUES($1,0) ON CONFLICT(tenant_id) DO NOTHING', [tenantId]);
      await c.query('SELECT tenant_id FROM wallets WHERE tenant_id=$1 FOR UPDATE', [tenantId]);
      const saved = await c.query(
        'INSERT INTO referral_redemptions(tenant_id,amount_kes) VALUES($1,$2) RETURNING id,amount_kes,created_at',
        [tenantId, requested],
      );
      await c.query('UPDATE wallets SET balance_kes=balance_kes+$1 WHERE tenant_id=$2', [requested, tenantId]);
      await c.query(
        `INSERT INTO wallet_transactions(tenant_id,change_kes,reason) VALUES($1,$2,'referral_redemption')`,
        [tenantId, requested],
      );
      return {
        redeemed: true,
        amountKes: Number(saved.rows[0].amount_kes),
        receiptCreditsAdded: Math.floor(requested / RECEIPT_FEE_KES),
        receiptFeeKes: RECEIPT_FEE_KES,
        message: 'Referral rewards have been added to your receipt wallet.',
      };
    });
  }

  @Post('withdraw')
  @Roles('owner')
  async requestWithdrawal() {
    throw new BadRequestException('Cash withdrawals are no longer available. Redeem referral rewards into receipt wallet credits instead.');
  }
}
