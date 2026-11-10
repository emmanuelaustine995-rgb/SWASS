import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { DbService } from '../db/db.service';

@Injectable()
export class EmailVerificationService {
  constructor(private db: DbService) {}

  async send(userId: string, email: string, fullName: string) {
    const apiKey = process.env.BREVO_API_KEY?.trim();
    const from = process.env.BREVO_FROM_EMAIL?.trim();
    if (!apiKey || !from) return { sent: false, reason: 'Brevo email provider is not configured' };
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await this.db.pool.query(
      `INSERT INTO email_verification_tokens(user_id,email,token_hash,expires_at)
       VALUES($1,$2,$3,now()+interval '30 minutes')`,
      [userId,email,tokenHash],
    );
    const verifyUrl = `${(process.env.PUBLIC_APP_URL || 'https://swass-web.onrender.com').replace(/\/$/,'')}/verify-email.html?token=${encodeURIComponent(token)}`;
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: from, name: 'SWASS' }, to: [{ email }], subject: 'Verify your SWASS business email',
        htmlContent: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#17251f"><h2>Welcome to SWASS, ${this.escape(fullName)}</h2><p>Confirm your email address to keep your business account details up to date.</p><p><a href="${verifyUrl}" style="display:inline-block;padding:13px 20px;background:#176b4a;color:#fff;text-decoration:none;border-radius:8px">Verify email address</a></p><p>This link expires in 30 minutes. If you did not create this account, ignore this message.</p></div>`,
      }),
    });
    if (!response.ok) throw new Error('Email verification message could not be sent');
    return { sent: true };
  }

  async sendReceipt(input: {
    to:string; customerName:string; receiptNo:string; totalKes:number; pdf?:Buffer;
    issuedAt:string|Date; businessName:string; storeName:string;
    businessPhone?:string; businessEmail?:string; storeLocation?:string; logoData?:string;
    receiptHeader?:string; receiptFooter?:string; cashierName?:string; cashierPhone?:string;
    paymentMethod:string; subtotalKes:number; discountKes:number; verificationUrl?:string; recoveryUrl?:string;
    items:{name:string;qty:number;unitPriceKes:number;lineTotalKes:number;serialNo?:string|null}[];
  }) {
    const apiKey=process.env.BREVO_API_KEY?.trim(), from=process.env.BREVO_FROM_EMAIL?.trim();
    if(!apiKey||!from)throw new Error('Brevo email provider is not configured. Set BREVO_API_KEY and BREVO_FROM_EMAIL.');
    const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
    const money=(n:number)=>Number(n||0).toLocaleString('en-KE',{minimumFractionDigits:2,maximumFractionDigits:2});
    const issued=new Date(input.issuedAt).toLocaleString('en-KE',{timeZone:'Africa/Nairobi'});
    const rows=input.items.map(i=>`<tr><td style="padding:11px 8px;border-bottom:1px dashed #cbd5d1"><strong>${esc(i.name)}</strong>${i.serialNo?`<br><small>IMEI / Serial: ${esc(i.serialNo)}</small>`:''}<br><small>Unit price: KSh ${money(i.unitPriceKes)}</small></td><td align="center" style="padding:11px 4px;border-bottom:1px dashed #cbd5d1">${i.qty}</td><td align="right" style="padding:11px 8px;border-bottom:1px dashed #cbd5d1">KSh ${money(i.lineTotalKes)}</td></tr>`).join('');
    const logo=input.logoData?.startsWith('data:image/')?`<img src="${esc(input.logoData)}" alt="Business logo" style="max-width:110px;max-height:75px;object-fit:contain;margin-bottom:10px">`:'';
    const html=`<div style="margin:0 auto;max-width:620px;background:#fff;border:1px solid #dce8e2;border-radius:16px;padding:26px;color:#17251f;font-family:Arial,sans-serif">
      <div style="text-align:center">${logo}<h1 style="font-size:23px;color:#145c43;margin:4px 0">${esc(input.businessName)}</h1>
      ${input.storeName?`<div>${esc(input.storeName)}</div>`:''}${input.storeLocation?`<div>${esc(input.storeLocation)}</div>`:''}
      ${input.businessPhone?`<div>Tel: ${esc(input.businessPhone)}</div>`:''}${input.businessEmail?`<div>Email: ${esc(input.businessEmail)}</div>`:''}
      ${input.receiptHeader?`<p>${esc(input.receiptHeader)}</p>`:''}<strong style="letter-spacing:2px">OFFICIAL SALES RECEIPT</strong></div>
      <hr style="border:0;border-top:1px dashed #82938a;margin:18px 0">
      <p><strong>Receipt:</strong> ${esc(input.receiptNo)}</p><p><strong>Date sold:</strong> ${esc(issued)}</p>
      <p><strong>Customer:</strong> ${esc(input.customerName)}</p><p><strong>Sales agent:</strong> ${esc(input.cashierName||'Staff')}${input.cashierPhone?' · '+esc(input.cashierPhone):''}</p>
      <p><strong>Payment:</strong> ${esc(input.paymentMethod.toUpperCase())}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr style="background:#edf5f0"><th align="left" style="padding:10px 8px">ITEM</th><th>QTY</th><th align="right">TOTAL</th></tr></thead><tbody>${rows}</tbody></table>
      <div style="margin-top:16px;text-align:right"><p>Subtotal: KSh ${money(input.subtotalKes)}</p><p>Discount: KSh ${money(input.discountKes)}</p>
      <div style="background:#e8f3ed;color:#145c43;padding:14px;border-radius:8px;font-size:20px;font-weight:bold">TOTAL PAID: KSh ${money(input.totalKes)}</div></div>
      <div style="text-align:center;margin:24px auto;color:#a32626;border:3px double #a32626;border-radius:50%;width:135px;height:115px;padding-top:20px;box-sizing:border-box"><strong style="font-size:25px">ISSUED</strong><br><small>${esc(new Date(input.issuedAt).toLocaleDateString('en-KE',{timeZone:'Africa/Nairobi'}))}</small></div>
      <div style="text-align:center;margin-top:18px"><strong>Thank you for shopping with us!</strong>${input.receiptFooter?`<p>${esc(input.receiptFooter)}</p>`:''}
      ${input.verificationUrl?`<p><a href="${esc(input.verificationUrl)}">Verify this receipt online</a></p>`:''}
      ${input.recoveryUrl?`<p><a href="${esc(input.recoveryUrl)}">Recover a lost receipt</a></p>`:''}</div>
      <p style="font-size:12px;color:#65736b;text-align:center">Your complete, branded PDF receipt is attached to this email.</p></div>`;
    const response=await fetch('https://api.brevo.com/v3/smtp/email',{method:'POST',signal:AbortSignal.timeout(15000),
      headers:{'api-key':apiKey,'Content-Type':'application/json',accept:'application/json'},
      body:JSON.stringify({sender:{email:from,name:input.businessName||'AURORA E-RECEIPT'},to:[{email:input.to,name:input.customerName}],
        subject:`Your receipt ${input.receiptNo} from ${input.businessName}`,htmlContent:html,
        ...(input.pdf?{attachment:[{name:`${input.receiptNo}.pdf`,content:input.pdf.toString('base64') }]}:{})})});
    const raw=await response.text();if(!response.ok)throw new Error(`Brevo HTTP ${response.status}: ${raw.slice(0,240)}`);
    return {sent:true,provider:'brevo'};
  }

  async sendSecondHandReceipt(input: {
    to: string; recipientName: string; reference: string; productName: string;
    sellerName: string; buyerName: string; pdf: Buffer;
  }) {
    const apiKey=process.env.BREVO_API_KEY?.trim(), from=process.env.BREVO_FROM_EMAIL?.trim();
    if(!apiKey||!from)throw new Error('Brevo email provider is not configured. Set BREVO_API_KEY and BREVO_FROM_EMAIL.');
    const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
    const response=await fetch('https://api.brevo.com/v3/smtp/email',{
      method:'POST',signal:AbortSignal.timeout(15000),
      headers:{'api-key':apiKey,'Content-Type':'application/json',accept:'application/json'},
      body:JSON.stringify({
        sender:{email:from,name:'AURORA E-RECEIPT'},
        to:[{email:input.to,name:input.recipientName}],
        subject:`Second-Hand Receipt ${input.reference} · ${input.productName}`,
        htmlContent:`<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#17324d"><h2>AURORA Second-Hand Receipt</h2><p>Hello ${esc(input.recipientName)},</p><p>The second-hand sale record for <strong>${esc(input.productName)}</strong> has been completed. This copy is for your records.</p><p><strong>Receipt reference:</strong> ${esc(input.reference)}<br><strong>Seller:</strong> ${esc(input.sellerName)}<br><strong>Buyer:</strong> ${esc(input.buyerName)}</p><p>The PDF document is attached. Please keep it safely.</p><p>AURORA E-RECEIPT</p></div>`,
        attachment:[{name:`AURORA-Second-Hand-${input.reference}.pdf`,content:input.pdf.toString('base64')}]
      })
    });
    const raw=await response.text();
    if(!response.ok)throw new Error(`Brevo HTTP ${response.status}: ${raw.slice(0,240)}`);
    return {sent:true,provider:'brevo'};
  }


  async sendLoanNote(input: { to: string; ownerName: string; businessName: string; reference: string; itemName: string; borrowerName: string; pdf: Buffer }) {
    const apiKey=process.env.BREVO_API_KEY?.trim(), from=process.env.BREVO_FROM_EMAIL?.trim();
    if(!apiKey||!from)throw new Error('Brevo email provider is not configured. Set BREVO_API_KEY and BREVO_FROM_EMAIL.');
    const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
    const response=await fetch('https://api.brevo.com/v3/smtp/email',{method:'POST',signal:AbortSignal.timeout(15000),
      headers:{'api-key':apiKey,'Content-Type':'application/json',accept:'application/json'},
      body:JSON.stringify({sender:{email:from,name:input.businessName||'AURORA E-RECEIPT'},to:[{email:input.to,name:input.ownerName}],
        subject:`Item on loan: ${input.itemName} · ${input.reference}`,
        htmlContent:`<div style="font-family:Arial,sans-serif;color:#493d2b"><h2>New item issued on loan</h2><p>Dear ${esc(input.ownerName)},</p><p>${esc(input.borrowerName)} has been issued <strong>${esc(input.itemName)}</strong>.</p><p>Loan reference: ${esc(input.reference)}. The completed loan note PDF is attached.</p></div>`,
        attachment:[{name:`AURORA-Loan-${input.reference}.pdf`,content:input.pdf.toString('base64')}]})});
    const raw=await response.text();if(!response.ok)throw new Error(`Brevo HTTP ${response.status}: ${raw.slice(0,220)}`);
    return {sent:true,provider:'brevo'};
  }

  async sendLostItemAlert(input:{to:string;recipientName:string;itemName:string;itemCode:string;warning:string}) {
    const apiKey=process.env.BREVO_API_KEY?.trim(),from=process.env.BREVO_FROM_EMAIL?.trim();
    if(!apiKey||!from)throw new Error('Brevo email provider is not configured');
    const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
    const response=await fetch('https://api.brevo.com/v3/smtp/email',{method:'POST',signal:AbortSignal.timeout(15000),headers:{'api-key':apiKey,'Content-Type':'application/json',accept:'application/json'},body:JSON.stringify({sender:{email:from,name:'AURORA E-RECEIPT'},to:[{email:input.to,name:input.recipientName}],subject:'URGENT AURORA LOST ITEM ALERT · '+input.itemCode,htmlContent:`<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;border:3px solid #dc2626;border-radius:12px;color:#7f1d1d"><h1 style="color:#b91c1c">AURORA LOST ITEM ALERT</h1><p>${esc(input.warning)}</p><p><strong>Item:</strong> ${esc(input.itemName)}<br><strong>AURORA reference:</strong> ${esc(input.itemCode)}</p><p>Do not confront anyone. Preserve the information and contact the appropriate authorities.</p></div>`})});
    const raw=await response.text();if(!response.ok)throw new Error('Brevo alert failed: '+raw.slice(0,200));return {sent:true,provider:'brevo'};
  }

  async verify(token: string) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) throw new BadRequestException('Invalid or expired verification link');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    return this.db.tx(async c => {
      const found = await c.query(
        `SELECT id,user_id,email FROM email_verification_tokens
         WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE`, [tokenHash],
      );
      const row = found.rows[0];
      if (!row) throw new BadRequestException('Verification link is invalid or has expired. Request a new one.');
      await c.query('UPDATE email_verification_tokens SET used_at=now() WHERE id=$1',[row.id]);
      await c.query('UPDATE users SET email=$1,email_verified_at=now() WHERE id=$2',[row.email,row.user_id]);
      return { verified: true, message: 'Your email address has been verified.' };
    });
  }

  private escape(value: string) {
    return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  }
}
