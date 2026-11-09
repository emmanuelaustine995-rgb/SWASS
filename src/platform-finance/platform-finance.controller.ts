import { BadRequestException, Body, Controller, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';

@Controller('api/v1/platform-finance')
@UseGuards(AuthGuard, RolesGuard)
@Roles('super_admin')
export class PlatformFinanceController {
  constructor(private db: DbService) {}

  @Get('summary')
  async summary() {
    const [ledger, splits, withdrawals] = await Promise.all([
      this.db.pool.query(`SELECT
        COALESCE(SUM(amount_kes) FILTER (WHERE entry_type='subscription_revenue'),0)::bigint AS subscriptions_kes,
        COALESCE(SUM(amount_kes) FILTER (WHERE entry_type='receipt_fee_revenue'),0)::bigint AS receipt_fees_kes,
        COALESCE(SUM(amount_kes),0)::bigint AS total_kes, COUNT(*)::int AS entries
       FROM platform_financial_ledger`),
      this.db.pool.query(`SELECT COALESCE(SUM(company_amount_kes),0)::bigint AS company_kes,
        COALESCE(SUM(referral_amount_kes),0)::bigint AS referral_kes FROM platform_payment_splits`),
      this.db.pool.query(`SELECT COALESCE(SUM(amount_kes) FILTER (WHERE status IN ('pending','approved')),0)::bigint AS pending_kes
        FROM referral_withdrawal_requests`),
    ]);
    const row=ledger.rows[0];
    return {
      subscriptionRevenueKes:Number(row.subscriptions_kes),receiptFeeRevenueKes:Number(row.receipt_fees_kes),
      totalPlatformRevenueKes:Number(row.total_kes),ledgerEntries:row.entries,
      companyShareFromReferralPaymentsKes:Number(splits.rows[0].company_kes),
      referralCommissionLiabilityKes:Number(splits.rows[0].referral_kes),
      pendingReferralWithdrawalsKes:Number(withdrawals.rows[0].pending_kes),
      excludesShopSales:true,bankSettlementVerified:false,
    };
  }

  @Get('entries')
  async entries() {
    const result = await this.db.pool.query(
      `SELECT id, entry_type AS "entryType", amount_kes AS "amountKes",
              external_reference AS "externalReference", created_at AS "createdAt"
         FROM platform_financial_ledger ORDER BY created_at DESC, id DESC LIMIT 100`
    );
    return { entries: result.rows };
  }

  @Get('referral-withdrawals')
  async referralWithdrawals() {
    const result=await this.db.pool.query(`SELECT r.id,r.tenant_id AS "tenantId",t.name AS "businessName",
      r.amount_kes AS "amountKes",r.payout_phone AS "payoutPhone",r.status,
      r.payout_reference AS "payoutReference",r.admin_note AS "adminNote",
      r.created_at AS "createdAt",r.processed_at AS "processedAt"
      FROM referral_withdrawal_requests r JOIN tenants t ON t.id=r.tenant_id
      ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,r.created_at ASC LIMIT 200`);
    return {withdrawals:result.rows};
  }

  @Patch('referral-withdrawals/:id')
  async updateReferralWithdrawal(@Req() req:any,@Param('id') id:string,@Body() body:{status?:string;payoutReference?:string;adminNote?:string}) {
    const status=String(body?.status||'');
    if(!['approved','rejected','paid'].includes(status)) throw new BadRequestException('Choose approved, rejected or paid.');
    const reference=String(body?.payoutReference||'').trim();
    const note=String(body?.adminNote||'').trim().slice(0,500);
    if(status==='paid'&&(!reference||reference.length>120)) throw new BadRequestException('Enter the M-Pesa or bank transfer reference before marking a withdrawal paid.');
    return this.db.tx(async c=>{
      const found=await c.query('SELECT id,status FROM referral_withdrawal_requests WHERE id=$1 FOR UPDATE',[id]);
      if(!found.rowCount) throw new BadRequestException('Withdrawal request not found.');
      const current=found.rows[0].status;
      const allowed=(status==='approved'||status==='rejected')?current==='pending':current==='approved';
      if(!allowed) throw new BadRequestException(`Cannot change a ${current} request to ${status}.`);
      const saved=await c.query(`UPDATE referral_withdrawal_requests SET status=$1,
        payout_reference=CASE WHEN $1='paid' THEN $2 ELSE payout_reference END,
        admin_note=COALESCE(NULLIF($3,''),admin_note),processed_by=$4,processed_at=now()
        WHERE id=$5 RETURNING id,status,amount_kes AS "amountKes",payout_reference AS "payoutReference",processed_at AS "processedAt"`,
        [status,reference||null,note,req.user?.sub||null,id]);
      return {updated:true,withdrawal:saved.rows[0],note:status==='paid'?'Marked paid. Ensure the external transfer has already been completed.':'Withdrawal status updated.'};
    });
  }
}
