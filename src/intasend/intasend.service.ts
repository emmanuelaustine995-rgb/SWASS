import { Injectable, HttpException, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';

@Injectable()
export class IntaSendService {
  private config() {
    const secretKey=(process.env.INTASEND_SECRET_KEY??'').trim().replace(/^Bearer\s+/i,'');
    const challenge=(process.env.INTASEND_WEBHOOK_CHALLENGE??'').trim();
    if(!/^ISSecretKey_(test|live)_/.test(secretKey)) throw new ServiceUnavailableException('IntaSend secret key is missing or invalid. Add INTASEND_SECRET_KEY in Render.');
    if(!challenge||challenge.length<24) throw new ServiceUnavailableException('IntaSend webhook challenge is not configured. Add a private challenge of at least 24 characters in Render.');
    return {secretKey,challenge};
  }

  async initiate(input:{phone:string;amount:number;paymentId:string}):Promise<string>{
    const cfg=this.config();
    let response:Response;
    try{
      response=await fetch('https://api.intasend.com/api/v1/payment/mpesa-stk-push/',{
        method:'POST',
        headers:{Authorization:'Bearer '+cfg.secretKey,'Content-Type':'application/json'},
        body:JSON.stringify({amount:input.amount,phone_number:input.phone,api_ref:input.paymentId}),
        signal:AbortSignal.timeout(25000),
      });
    }catch{
      throw new ServiceUnavailableException('IntaSend STK request timed out or could not be reached. Check payment status before retrying.');
    }
    const data:any=await response.json().catch(()=>({}));
    const invoiceId=data?.invoice?.invoice_id;
    if(!response.ok||typeof invoiceId!=='string'||!invoiceId){
      const detail=typeof data?.detail==='string'?data.detail:typeof data?.message==='string'?data.message:'IntaSend did not accept the STK request';
      throw new HttpException(detail,HttpStatus.BAD_GATEWAY);
    }
    return invoiceId;
  }

  validWebhookChallenge(candidate:unknown):boolean{
    const expected=process.env.INTASEND_WEBHOOK_CHALLENGE??'';
    if(typeof candidate!=='string'||!expected||candidate.length>512)return false;
    return timingSafeEqual(createHash('sha256').update(candidate).digest(),createHash('sha256').update(expected).digest());
  }
}
