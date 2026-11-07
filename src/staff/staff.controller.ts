import { BadRequestException, Controller, Delete, Get, Post, Body, Req, UseGuards } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';

@Controller('api/v1/staff')
export class StaffController {
  constructor(private db: DbService) {}

  private hash(token: string) { return createHash('sha256').update(token).digest('hex'); }
  private escape(value: unknown) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  }

  @Post('invitations/accept')
  async acceptInvitation(@Body() body: { token?: string; password?: string }) {
    const token = String(body?.token ?? '');
    const password = String(body?.password ?? '');
    if (token.length < 32 || token.length > 200) throw new BadRequestException('This invitation link is invalid or expired.');
    if (password.length < 10 || password.length > 128) throw new BadRequestException('Choose a password of at least 10 characters.');
    const passwordHash = await argon2.hash(password);
    return this.db.tx(async c => {
      const found = await c.query(
        `SELECT * FROM staff_email_invitations
          WHERE token_hash=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()
          FOR UPDATE`, [this.hash(token)],
      );
      const invite = found.rows[0];
      if (!invite) throw new BadRequestException('This invitation link is invalid, expired or already used. Ask the shop owner to send another invitation.');
      const phoneDigits = String(invite.phone).replace(/\D/g, '');
      const phone = phoneDigits.startsWith('0') ? '254' + phoneDigits.slice(1) : phoneDigits.startsWith('254') ? phoneDigits : '254' + phoneDigits;
      const duplicate = await c.query(
        `SELECT 1 FROM users WHERE regexp_replace(phone,'[^0-9]','','g') IN ($1,$2)
           OR lower(email)=lower($3) LIMIT 1`,
        [phone, '0' + phone.slice(3), invite.email],
      );
      if (duplicate.rowCount) throw new BadRequestException('This phone number or email is already registered. Contact the shop owner.');
      const inserted = await c.query(
        `INSERT INTO users (tenant_id,store_id,full_name,phone,email,password_hash,role,must_change_password,staff_title,profile_photo_data)
         VALUES ($1,$2,$3,$4,$5,$6,'cashier',false,$7,$8) RETURNING id`,
        [invite.tenant_id, invite.store_id, invite.full_name, phone, invite.email, passwordHash, invite.job_title, invite.profile_photo_data],
      );
      await c.query('UPDATE staff_email_invitations SET accepted_by=$1,accepted_at=now() WHERE id=$2', [inserted.rows[0].id, invite.id]);
      return { accepted: true, message: 'Your staff account is ready. Sign in with your phone number and the password you just created.' };
    });
  }

  @Post('invitations')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('owner')
  async createInvitation(@Req() req: any, @Body() body: { fullName?: string; email?: string; phone?: string; role?: string; profilePhotoData?: string }) {
    const user = req.user;
    if (!user?.tenantId || !user?.storeId) throw new BadRequestException('Business owner account required.');
    const fullName = String(body?.fullName ?? '').trim();
    const email = String(body?.email ?? '').trim().toLowerCase();
    const rawPhone = String(body?.phone ?? '').trim();
    const digits = rawPhone.replace(/\D/g, '');
    const phone = digits.startsWith('254') ? digits : digits.startsWith('0') ? '254' + digits.slice(1) : '254' + digits;
    const jobTitle = String(body?.role ?? 'Shop Attendant').trim();
    const allowed = ['Cashier','Shop Attendant','Salesperson','Store Assistant'];
    if (!fullName || fullName.length > 120) throw new BadRequestException('Enter the staff member’s full name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new BadRequestException('Enter a valid staff email address.');
    if (!/^254\d{9}$/.test(phone)) throw new BadRequestException('Enter a valid Kenyan phone number.');
    if (!allowed.includes(jobTitle)) throw new BadRequestException('Choose a valid staff role.');
    const photo = body?.profilePhotoData || null;
    if (photo && (typeof photo !== 'string' || photo.length > 65000 || !/^data:image\/(jpeg|png|webp);base64,/.test(photo))) {
      throw new BadRequestException('Profile photo must be a small PNG, JPG or WebP image (maximum 45 KB).');
    }
    const exists = await this.db.pool.query(
      `SELECT 1 FROM users WHERE regexp_replace(phone,'[^0-9]','','g') IN ($1,$2) OR lower(email)=lower($3) LIMIT 1`,
      [phone, '0' + phone.slice(3), email],
    );
    if (exists.rowCount) throw new BadRequestException('A user with this phone number or email already exists.');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 7 * 86400000);
    const saved = await this.db.pool.query(
      `INSERT INTO staff_email_invitations
       (tenant_id,store_id,created_by,full_name,email,phone,job_title,profile_photo_data,token_hash,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,expires_at`,
      [user.tenantId,user.storeId,user.sub,fullName,email,phone,jobTitle,photo,this.hash(token),expiresAt],
    );
    const apiKey = process.env.BREVO_API_KEY?.trim();
    const from = process.env.BREVO_FROM_EMAIL?.trim();
    if (!apiKey || !from) {
      await this.db.pool.query('DELETE FROM staff_email_invitations WHERE id=$1', [saved.rows[0].id]);
      throw new BadRequestException('Brevo email is not configured. Set BREVO_API_KEY and BREVO_FROM_EMAIL in the API hosting settings.');
    }
    const base = (process.env.PUBLIC_APP_URL || 'https://swass-web.onrender.com').replace(/\/$/,'');
    const inviteUrl = base + '/staff-invite.html?token=' + encodeURIComponent(token);
    const safeName = this.escape(fullName), safeRole = this.escape(jobTitle);
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#172033;padding:24px"><h2>Welcome to AURORA E-RECEIPT</h2><p>Hello ${safeName},</p><p>You have been invited to join a shop as <strong>${safeRole}</strong>.</p><p>Use the secure button below to accept your invitation and create your own password. Your link expires in 7 days and can only be used once.</p><p><a href="${inviteUrl}" style="display:inline-block;background:#176bce;color:white;padding:14px 22px;border-radius:8px;text-decoration:none">Accept staff invitation</a></p><p>If you were not expecting this invitation, you can ignore this email.</p></div>`;
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: from, name: 'AURORA E-RECEIPT' },
        to: [{ email, name: fullName }],
        subject: 'You are invited to join a shop on AURORA E-RECEIPT',
        htmlContent: html,
      }),
    });
    const providerReply = await response.text();
    if (!response.ok) {
      await this.db.pool.query('DELETE FROM staff_email_invitations WHERE id=$1', [saved.rows[0].id]);
      console.error('[AURORA] Staff invitation email provider rejected the message:', response.status, providerReply.slice(0, 180));
      throw new BadRequestException('Invitation email could not be sent. Check that your email sender is verified and the email provider credentials are correct.');
    }
    return { invitation: { id: saved.rows[0].id, fullName, email, phone, role: jobTitle, expiresAt: saved.rows[0].expires_at, emailSent: true } };
  }

  @Get('invitations')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('owner')
  async listInvitations(@Req() req: any) {
    const result = await this.db.pool.query(
      `SELECT id,full_name AS "fullName",email,phone,job_title AS role,expires_at AS "expiresAt",
              accepted_at IS NOT NULL AS accepted,revoked_at AS "revokedAt"
         FROM staff_email_invitations
        WHERE tenant_id=$1 AND store_id=$2 ORDER BY created_at DESC LIMIT 50`,
      [req.user.tenantId,req.user.storeId],
    );
    return { invitations: result.rows };
  }

  @Delete('invitations/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('owner')
  async revokeInvitation(@Req() req: any) {
    const result = await this.db.pool.query(
      `UPDATE staff_email_invitations SET revoked_at=now()
        WHERE id=$1 AND tenant_id=$2 AND store_id=$3 AND accepted_at IS NULL AND revoked_at IS NULL
        RETURNING id`,
      [String(req.params?.id || ''),req.user.tenantId,req.user.storeId],
    );
    if (!result.rowCount) throw new BadRequestException('Invitation not found or already used.');
    return { revoked: true };
  }
}
