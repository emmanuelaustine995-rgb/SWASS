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
