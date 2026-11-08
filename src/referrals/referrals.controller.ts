import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';

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
    const [counts, earned, committed, owner] = await Promise.all([
      this.db.pool.query(`SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id=tr.referred_tenant_id AND s.status='active' AND s.ends_at>now()))::int AS active
        FROM tenant_referrals tr WHERE tr.referrer_tenant_id=$1`, [tenantId]),
      this.db.pool.query('SELECT COALESCE(SUM(amount_kes),0)::bigint AS total FROM referral_rewards WHERE referrer_tenant_id=$1', [tenantId]),
      this.db.pool.query(`SELECT COALESCE(SUM(amount_kes),0)::bigint AS total FROM referral_withdrawal_requests
        WHERE tenant_id=$1 AND status IN ('pending','approved','paid')`, [tenantId]),
      this.db.pool.query('SELECT phone FROM tenants WHERE id=$1', [tenantId]),
    ]);
    const earnedKes=Number(earned.rows[0].total||0), committedKes=Number(committed.rows[0].total||0);
    const baseUrl=(process.env.AURORA_WEB_URL||'https://swass-web.onrender.com').replace(/\/$/,'');
    return {referralCode:result.rows[0].referral_code,referralLink:`${baseUrl}/?ref=${encodeURIComponent(result.rows[0].referral_code)}`,
      totalReferrals:Number(counts.rows[0].total||0),activeReferrals:Number(counts.rows[0].active||0),
      earnedKes,availableKes:Math.max(0,earnedKes-committedKes),payoutPhone:owner.rows[0]?.phone||''};
  }

  @Post('withdraw')
  @Roles('owner')
  async requestWithdrawal(@Req() req:any,@Body() body:{phone?:string}) {
    const tenantId=req.user?.tenantId;
    if(!tenantId) throw new BadRequestException('Business owner account required');
    const digits=String(body?.phone||'').replace(/\D/g,'');
    const phone=digits.startsWith('254')&&digits.length===12?digits:digits.startsWith('0')&&digits.length===10?'254'+digits.slice(1):'';
    if(!/^254[17][0-9]{8}$/.test(phone)) throw new BadRequestException('Enter a valid Kenyan M-Pesa payout number.');
    return this.db.tx(async c=>{
      await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [tenantId]);
      const [earned,committed]=await Promise.all([
        c.query('SELECT COALESCE(SUM(amount_kes),0)::bigint AS total FROM referral_rewards WHERE referrer_tenant_id=$1',[tenantId]),
        c.query(`SELECT COALESCE(SUM(amount_kes),0)::bigint AS total FROM referral_withdrawal_requests WHERE tenant_id=$1 AND status IN ('pending','approved','paid')`,[tenantId]),
      ]);
      const available=Number(earned.rows[0].total||0)-Number(committed.rows[0].total||0);
      if(!Number.isSafeInteger(available)||available<50) throw new BadRequestException('You need at least KSh 50 in available referral cashback to request a payout.');
      const saved=await c.query('INSERT INTO referral_withdrawal_requests(tenant_id,amount_kes,payout_phone) VALUES($1,$2,$3) RETURNING id,amount_kes,status',[tenantId,available,phone]);
      return {requested:true,requestId:saved.rows[0].id,amountKes:Number(saved.rows[0].amount_kes),status:saved.rows[0].status,message:'Your referral payout request has been recorded for processing.'};
    });
  }
}
