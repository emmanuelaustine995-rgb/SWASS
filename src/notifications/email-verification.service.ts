import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { DbService } from '../db/db.service';

@Injectable()
export class EmailVerificationService {
  constructor(private db: DbService) {}

  async send(userId: string, email: string, fullName: string) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM_EMAIL;
    if (!apiKey || !from) return { sent: false, reason: 'Email verification provider is not configured' };
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await this.db.pool.query(
      `INSERT INTO email_verification_tokens(user_id,email,token_hash,expires_at)
       VALUES($1,$2,$3,now()+interval '30 minutes')`,
      [userId,email,tokenHash],
    );
    const verifyUrl = `${(process.env.PUBLIC_APP_URL || 'https://swass-web.onrender.com').replace(/\/$/,'')}/verify-email.html?token=${encodeURIComponent(token)}`;
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to: [email], subject: 'Verify your SWASS business email',
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#17251f"><h2>Welcome to SWASS, ${this.escape(fullName)}</h2><p>Confirm your email address to keep your business account details up to date.</p><p><a href="${verifyUrl}" style="display:inline-block;padding:13px 20px;background:#176b4a;color:#fff;text-decoration:none;border-radius:8px">Verify email address</a></p><p>This link expires in 30 minutes. If you did not create this account, ignore this message.</p></div>`,
      }),
    });
    if (!response.ok) throw new Error('Email verification message could not be sent');
    return { sent: true };
  }

  async sendReceipt(input: {
    to: string; customerName: string; receiptNo: string; totalKes: number; pdf?: Buffer;
    issuedAt: string | Date; businessName: string; storeName: string;
    items: { name: string; qty: number; unitPriceKes: number; lineTotalKes: number; serialNo?: string | null }[];
  }) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM_EMAIL;
    if (!apiKey || !from) throw new Error('Receipt email provider is not configured');
    const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
    const issued = new Date(input.issuedAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: AbortSignal.timeout(12000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to: [input.to], subject: `Your receipt ${input.receiptNo} from ${input.businessName}`,
        ...(input.pdf ? { attachments: [{ filename: `${input.receiptNo}.pdf`, content: input.pdf.toString('base64') }] } : {}),
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#17251f;padding:20px"><h2 style="color:#176b4a">Thank you for shopping with ${escape(input.businessName)}</h2><p>Hello ${escape(input.customerName)},</p><p>Your receipt has been issued successfully.</p><div style="border:1px solid #dce8e2;border-radius:12px;padding:18px"><p><strong>Receipt:</strong> ${escape(input.receiptNo)}</p><p><strong>Branch:</strong> ${escape(input.storeName || 'Main branch')}</p><p><strong>Date:</strong> ${escape(issued)}</p><p style="font-size:22px"><strong>Total paid: KSh ${Number(input.totalKes).toLocaleString('en-KE')}</strong></p><table style="width:100%;border-collapse:collapse;margin-top:16px"><thead><tr><th align="left" style="border-bottom:1px solid #ddd;padding:8px">Item</th><th align="right" style="border-bottom:1px solid #ddd;padding:8px">Qty</th><th align="right" style="border-bottom:1px solid #ddd;padding:8px">Amount</th></tr></thead><tbody>${input.items.map(item => `<tr><td style="border-bottom:1px solid #eee;padding:8px">${escape(item.name)}${item.serialNo ? `<br><small>IMEI/Serial: ${escape(item.serialNo)}</small>` : ''}</td><td align="right" style="border-bottom:1px solid #eee;padding:8px">${Number(item.qty)}</td><td align="right" style="border-bottom:1px solid #eee;padding:8px">KSh ${Number(item.lineTotalKes).toLocaleString('en-KE')}</td></tr>`).join('')}</tbody></table></div><p>Keep this email as your digital receipt. You can contact the business if you need assistance.</p></div>`,
      }),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Resend HTTP ${response.status}: ${raw.slice(0,180)}`);
    return { sent: true };
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
