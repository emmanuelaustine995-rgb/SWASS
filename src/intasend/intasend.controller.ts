import { Body, Controller, Post } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { IntaSendService } from './intasend.service';

@Controller('api/v1/intasend')
export class IntaSendController {
  constructor(private db:DbService,private intasend:IntaSendService){}

  @Post('webhook')
  async webhook(@Body() body:any){
    if(!this.intasend.validWebhookChallenge(body?.challenge)) return {accepted:false};
    if(body?.topic!=='collection_event') return {accepted:true};
    const invoiceId=typeof body?.invoice_id==='string'?body.invoice_id:'';
    const paymentId=typeof body?.api_ref==='string'?body.api_ref:'';
    if(!invoiceId||!paymentId)return {accepted:true};
    try{
      await this.db.tx(async c=>{
        const found=await c.query('SELECT * FROM payments WHERE id=$1 AND checkout_request_id=$2 FOR UPDATE',[paymentId,invoiceId]);
        if(!found.rowCount)return;
        const p=found.rows[0];
        if(p.status!=='pending'||p.purpose!=='subscription')return;
        const state=String(body?.state??'').toUpperCase();
        if(state==='FAILED'||state==='CANCELED'){
          await c.query("UPDATE payments SET status='failed' WHERE id=$1 AND status='pending'",[p.id]);
          return;
        }
        if(state!=='COMPLETE')return;
        const amountCents=Math.round(Number(body?.value)*100);
        if(!Number.isFinite(amountCents)||amountCents!==Number(p.amount_kes)*100||String(body?.currency??'').toUpperCase()!=='KES')return;
        const account=typeof body?.account==='string'?body.account.replace(/\\D/g,''):'';
        if(account&&/^254[17]\\d{8}$/.test(account)&&account!==String(p.phone).replace(/\\D/g,''))return;
        const receipt=String(body?.mpesa_reference||body?.provider_ref||invoiceId).trim().slice(0,120);
        await c.query("UPDATE payments SET status='success',mpesa_receipt_no=$1 WHERE id=$2 AND status='pending'",[receipt,p.id]);
        await c.query("INSERT INTO platform_financial_ledger(tenant_id,payment_id,entry_type,amount_kes,external_reference) VALUES($1,$2,'subscription_revenue',$3,$4) ON CONFLICT DO NOTHING",[p.tenant_id,p.id,p.amount_kes,receipt]);
        const plan=Number(p.amount_kes)===900?'yearly':'monthly';
        const interval=plan==='yearly'?'1 year':'1 month';
        await c.query("INSERT INTO subscriptions(tenant_id,plan,price_kes,starts_at,ends_at,status,auto_renew) VALUES($1,$2,$3,COALESCE((SELECT MAX(ends_at) FROM subscriptions WHERE tenant_id=$1 AND status='active' AND ends_at>now()),now()),COALESCE((SELECT MAX(ends_at) FROM subscriptions WHERE tenant_id=$1 AND status='active' AND ends_at>now()),now())+$4::interval,'active',false)",[p.tenant_id,plan,p.amount_kes,interval]);
        const paid=await c.query("SELECT COUNT(*)::int AS paid_count FROM payments WHERE tenant_id=$1 AND purpose='subscription' AND status='success'",[p.tenant_id]);
        if(Number(paid.rows[0].paid_count)===1){
          const referral=await c.query("SELECT referrer_tenant_id FROM tenant_referrals WHERE referred_tenant_id=$1 AND referrer_tenant_id<>$1 FOR UPDATE",[p.tenant_id]);
          if(referral.rowCount){
            const referrerId=referral.rows[0].referrer_tenant_id;
            const reward=Math.floor(Number(p.amount_kes)*0.5);
            await c.query("INSERT INTO referral_rewards(referrer_tenant_id,referred_tenant_id,payment_id,amount_kes) VALUES($1,$2,$3,$4) ON CONFLICT(referred_tenant_id) DO NOTHING",[referrerId,p.tenant_id,p.id,reward]);
            await c.query("INSERT INTO platform_payment_splits(payment_id,tenant_id,payment_purpose,gross_amount_kes,company_amount_kes,referral_amount_kes,referrer_tenant_id) VALUES($1,$2,'subscription',$3,$4,$5,$6) ON CONFLICT(payment_id) DO NOTHING",[p.id,p.tenant_id,p.amount_kes,Number(p.amount_kes)-reward,reward,referrerId]);
          }
        }
      });
    }catch(error){
      console.error('[AURORA IntaSend webhook processing failed]',error instanceof Error?error.message:'unknown error');
      return {accepted:false};
    }
    return {accepted:true};
  }
}
