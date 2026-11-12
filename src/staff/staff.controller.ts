import { BadRequestException, Controller, Delete, Get, Post, Patch, Body, Req, UseGuards } from '@nestjs/common';
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

  private async sendOwnerApprovalOtp(to: string, code: string): Promise<void> {
    const token = process.env.TALKSASA_API_TOKEN?.trim();
    if (!token) throw new BadRequestException('SMS approval is not configured. Set TALKSASA_API_TOKEN in the API hosting settings.');
    const configured = (process.env.TALKSASA_API_URL || 'https://bulksms.talksasa.com/api/v3/sms/send').trim();
    const endpoint = /\/sms\/send\/?$/i.test(configured) ? configured : `${configured.replace(/\/+$/, '')}/sms/send`;
    const response = await fetch(endpoint, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: `+${to}`, sender_id: process.env.TALKSASA_SENDER_ID || 'TALK-SASA', type: 'plain',
        message: `AURORA freelancer approval code: ${code}. It expires in 5 minutes. Do not share this code.` }),
    });
    const raw = await response.text();
    let result: any = {}; try { result = raw ? JSON.parse(raw) : {}; } catch {}
    const status = String(result?.status ?? result?.data?.status ?? '').toLowerCase();
    if (!response.ok || !(status === 'success' || status === 'accepted' || status === 'queued' || result?.success === true || result?.status === true)) {
      console.error('[AURORA] Freelancer approval SMS rejected:', response.status, String(result?.message ?? result?.error ?? raw).slice(0, 180));
      throw new BadRequestException('Could not send the owner approval code. Check TalkSasa credentials, sender ID and SMS balance.');
    }
  }

  // Public freelancer self-registration. The owner approves by OTP sent to the phone registered on the matched owner account.
  @Post('freelancer/register')
  async startFreelancerRegistration(@Body() body: {
    ownerName?: string; ownerPhone?: string; fullName?: string; phone?: string; email?: string;
    nationalIdNumber?: string; nationalIdPhotoData?: string; profilePhotoData?: string;
  }) {
    const normalizePhone = (value: unknown) => {
      const digits = String(value ?? '').replace(/\\D/g, '');
      return digits.startsWith('0') ? '254' + digits.slice(1) : digits.startsWith('254') ? digits : '254' + digits;
    };
    const ownerPhone = normalizePhone(body?.ownerPhone);
    const ownerName = String(body?.ownerName ?? '').trim().replace(/\\s+/g,' ');
    const fullName = String(body?.fullName ?? '').trim();
    const email = String(body?.email ?? '').trim().toLowerCase();
    const phone = normalizePhone(body?.phone);
    const nationalIdNumber = String(body?.nationalIdNumber ?? '').replace(/\\s+/g,'').trim();
    const nationalIdPhotoData = String(body?.nationalIdPhotoData ?? '');
    const profilePhotoData = String(body?.profilePhotoData ?? '');
    if (!ownerName || ownerName.length > 120 || !/^254\\d{9}$/.test(ownerPhone)) throw new BadRequestException('Enter the shop owner’s full name and registered phone number.');
    if (!fullName || fullName.length > 120) throw new BadRequestException('Enter your full name.');
    if (!/^254\\d{9}$/.test(phone)) throw new BadRequestException('Enter a valid Kenyan phone number.');
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) || email.length > 254) throw new BadRequestException('Enter a valid email address.');
    if (!/^\\d{6,12}$/.test(nationalIdNumber)) throw new BadRequestException('Enter a valid National ID number.');
    if (!/^data:image\\/(jpeg|png|webp);base64,/.test(nationalIdPhotoData) || nationalIdPhotoData.length > 1250000) throw new BadRequestException('Upload a clear JPG, PNG or WebP National ID photo (maximum 900 KB).');
    if (!/^data:image\\/(jpeg|png|webp);base64,/.test(profilePhotoData) || profilePhotoData.length > 420000) throw new BadRequestException('Upload a JPG, PNG or WebP profile photo (maximum 300 KB).');

    const ownerNationalPhone = ownerPhone.slice(3);
    const ownerLocalPhone = '0' + ownerNationalPhone;
    const owner = await this.db.pool.query(
      `SELECT u.id,u.tenant_id,u.store_id,
               CASE WHEN regexp_replace(coalesce(u.phone,''),'[^0-9]','','g') IN ($2,$3,$4) THEN u.phone ELSE t.phone END AS phone
         FROM users u
         LEFT JOIN tenants t ON t.id=u.tenant_id
        WHERE u.role='owner' AND u.is_active=true
          AND lower(regexp_replace(trim(coalesce(u.full_name,'')),'\\s+',' ','g'))=lower($1)
          AND (
            regexp_replace(coalesce(u.phone,''),'[^0-9]','','g') IN ($2,$3,$4)
            OR regexp_replace(coalesce(t.phone,''),'[^0-9]','','g') IN ($2,$3,$4)
          )
        LIMIT 1`,
      [ownerName,ownerPhone,ownerLocalPhone,ownerNationalPhone],
    );
    if (!owner.rowCount) throw new BadRequestException('No active shop-owner account matched that name and phone number. Check the details with the owner.');
    const duplicate = await this.db.pool.query(
      `SELECT 1 FROM users
        WHERE regexp_replace(phone,'[^0-9]','','g') IN ($1,$2)
           OR lower(email)=lower($3)
           OR national_id_number=$4
        LIMIT 1`,
      [phone,'0'+phone.slice(3),email,nationalIdNumber],
    );
    if (duplicate.rowCount) throw new BadRequestException('This freelancer phone, email or National ID is already registered. Sign in or contact support.');
    const recent = await this.db.pool.query(
      `SELECT count(*)::int AS total FROM staff_email_invitations
        WHERE created_by=$1 AND job_title='Freelancer' AND created_at>now()-interval '15 minutes'`,
      [owner.rows[0].id],
    );
    if (Number(recent.rows[0]?.total || 0) >= 3) throw new BadRequestException('Too many registration requests for this shop. Please wait 15 minutes or ask the owner to invite you directly.');
    const code = String(randomBytes(4).readUInt32BE(0) % 1000000).padStart(6,'0');
    const token = randomBytes(32).toString('base64url');
    const saved = await this.db.pool.query(
      `INSERT INTO staff_email_invitations
       (tenant_id,store_id,created_by,full_name,email,phone,job_title,token_hash,expires_at,approval_code_hash,approval_expires_at,approval_attempts,national_id_number,national_id_photo_data,profile_photo_data)
       VALUES($1,$2,$3,$4,$5,$6,'Freelancer',$7,now()+interval '30 minutes',$8,now()+interval '5 minutes',0,$9,$10,$11)
       RETURNING id`,
      [owner.rows[0].tenant_id,owner.rows[0].store_id,owner.rows[0].id,fullName,email,phone,this.hash(token),this.hash(code),nationalIdNumber,nationalIdPhotoData,profilePhotoData],
    );
    try {
      const normalizedOwnerPhone = String(owner.rows[0].phone).replace(/\\D/g,'');
      await this.sendOwnerApprovalOtp(normalizedOwnerPhone,code);
    } catch (error) {
      await this.db.pool.query('DELETE FROM staff_email_invitations WHERE id=$1',[saved.rows[0].id]);
      throw error;
    }
    return { approvalRequired:true, invitationId:saved.rows[0].id, ownerPhoneHint:String(owner.rows[0].phone).replace(/\\D/g,'').slice(-4),
      message:'The shop owner must approve your registration using the code sent to their registered phone.' };
  }

  @Post('freelancer/register/verify-otp')
  async finishFreelancerRegistration(@Body() body: { invitationId?: string; code?: string; password?: string }) {
    const id = String(body?.invitationId ?? '');
    const code = String(body?.code ?? '').trim();
    const password = String(body?.password ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(id) || !/^\d{6}$/.test(code)) throw new BadRequestException('Enter the six-digit owner approval code.');
    if (password.length < 10 || password.length > 128) throw new BadRequestException('Choose a password of at least 10 characters.');
    const result = await this.db.tx(async c => {
      const found = await c.query(
        `SELECT i.* FROM staff_email_invitations i
          JOIN users u ON u.id=i.created_by AND u.tenant_id=i.tenant_id
         WHERE i.id=$1 AND i.job_title='Freelancer' AND u.role='owner' AND u.is_active=true
           AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now()
           AND i.approval_expires_at>now() AND i.approval_attempts<5
         FOR UPDATE OF i`,[id],
      );
      const invite = found.rows[0];
      if (!invite) throw new BadRequestException('The approval request has expired or was already used. Start registration again.');
      if (this.hash(code) !== invite.approval_code_hash) {
        await c.query('UPDATE staff_email_invitations SET approval_attempts=approval_attempts+1 WHERE id=$1',[id]);
        return { wrongCode:true as const };
      }
      const phoneDigits=String(invite.phone).replace(/\D/g,'');
      const phone=phoneDigits.startsWith('0')?'254'+phoneDigits.slice(1):phoneDigits.startsWith('254')?phoneDigits:'254'+phoneDigits;
      const duplicate=await c.query(
        `SELECT 1 FROM users WHERE regexp_replace(phone,'[^0-9]','','g') IN ($1,$2) OR lower(email)=lower($3) LIMIT 1`,
        [phone,'0'+phone.slice(3),invite.email],
      );
      if(duplicate.rowCount) throw new BadRequestException('This freelancer phone number or email is already registered. Contact the shop owner.');
      const passwordHash=await argon2.hash(password);
      const inserted=await c.query(
        `INSERT INTO users (tenant_id,store_id,full_name,phone,email,password_hash,role,must_change_password,staff_title,profile_photo_data,national_id_number,national_id_photo_data)
         VALUES($1,$2,$3,$4,$5,$6,'freelancer',false,'Freelancer',$7,$8,$9) RETURNING id`,
        [invite.tenant_id,invite.store_id,invite.full_name,phone,invite.email,passwordHash,invite.profile_photo_data,invite.national_id_number,invite.national_id_photo_data],
      );
      await c.query(
        'UPDATE staff_email_invitations SET accepted_by=$1,accepted_at=now(),approval_code_hash=NULL,approval_expires_at=NULL WHERE id=$2',
        [inserted.rows[0].id,id],
      );
      return { created:true as const,message:'Your freelancer account is active. Sign in using the Freelancer tab with your phone number and password.' };
    });
    if ('wrongCode' in result && result.wrongCode) throw new BadRequestException('The owner approval code is incorrect.');
    return result;
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
      if (invite.job_title === 'Vendor') { const fee = await c.query(`SELECT status FROM vendor_invitation_fees WHERE invitation_id=$1 AND tenant_id=$2 FOR UPDATE`, [invite.id, invite.tenant_id]); if (!fee.rowCount || fee.rows[0].status !== 'paid') throw new BadRequestException('The shop owner must pay the one-time KSh 50 vendor activation fee before this invitation can be accepted.'); }
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
         VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8,NULL) RETURNING id`,
        [invite.tenant_id, invite.store_id, invite.full_name, phone, invite.email, passwordHash, invite.job_title === 'Vendor' ? 'vendor' : invite.job_title === 'Freelancer' ? 'freelancer' : 'cashier', invite.job_title],
      );
      await c.query('UPDATE staff_email_invitations SET accepted_by=$1,accepted_at=now() WHERE id=$2', [inserted.rows[0].id, invite.id]);
      return { accepted: true, message: 'Your AURORA account is ready. Sign in with your phone number and the password you just created.' };
    });
  }

  @Patch('profile-photo')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('cashier')
  async updateOwnProfilePhoto(@Req() req: any, @Body() body: { profilePhotoData?: string }) {
    const photo = String(body?.profilePhotoData ?? '');
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(photo) || photo.length > 65000) throw new BadRequestException('Choose a PNG, JPG or WebP image no larger than 45 KB.');
    await this.db.pool.query("UPDATE users SET profile_photo_data=$1 WHERE id=$2 AND role='cashier' AND tenant_id=$3 AND store_id=$4", [photo, req.user.sub, req.user.tenantId, req.user.storeId]);
    return { saved: true, profilePhotoData: photo };
  }

  @Post('invitations')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('owner')
  async createInvitation(@Req() req: any, @Body() body: { fullName?: string; email?: string; phone?: string; role?: string }) {
    const user = req.user;
    if (!user?.tenantId || !user?.storeId) throw new BadRequestException('Business owner account required.');
    const fullName = String(body?.fullName ?? '').trim();
    const email = String(body?.email ?? '').trim().toLowerCase();
    const rawPhone = String(body?.phone ?? '').trim();
    const digits = rawPhone.replace(/\D/g, '');
    const phone = digits.startsWith('254') ? digits : digits.startsWith('0') ? '254' + digits.slice(1) : '254' + digits;
    const jobTitle = String(body?.role ?? 'Vendor').trim();
    const allowed = ['Vendor','Freelancer'];
    if (!fullName || fullName.length > 120) throw new BadRequestException('Enter the staff member’s full name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new BadRequestException('Enter a valid staff email address.');
    if (!/^254\d{9}$/.test(phone)) throw new BadRequestException('Enter a valid Kenyan phone number.');
    if (!allowed.includes(jobTitle)) throw new BadRequestException('Choose Vendor or Freelancer.');
    const exists = await this.db.pool.query(
      `SELECT 1 FROM users WHERE regexp_replace(phone,'[^0-9]','','g') IN ($1,$2) OR lower(email)=lower($3) LIMIT 1`,
      [phone, '0' + phone.slice(3), email],
    );
    if (exists.rowCount) throw new BadRequestException('A user with this phone number or email already exists.');
    const token = randomBytes(32).toString('base64url');
    const approvalCode = String(randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, '0');
    const expiresAt = new Date(Date.now() + 7 * 86400000);
    const owner = await this.db.pool.query('SELECT phone FROM users WHERE id=$1 AND tenant_id=$2 AND role=\'owner\' AND is_active=true', [user.sub,user.tenantId]);
    if (!owner.rowCount) throw new BadRequestException('The shop owner account could not be verified.');
    const ownerPhone = String(owner.rows[0].phone).replace(/\D/g, '');
    const saved = await this.db.pool.query(
      `INSERT INTO staff_email_invitations
       (tenant_id,store_id,created_by,full_name,email,phone,job_title,token_hash,expires_at,approval_code_hash,approval_expires_at,approval_attempts)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+interval '5 minutes',0) RETURNING id,expires_at`,
      [user.tenantId,user.storeId,user.sub,fullName,email,phone,jobTitle,this.hash(token),expiresAt,this.hash(approvalCode)],
    );
    if (jobTitle === 'Freelancer') {
      try {
        await this.sendOwnerApprovalOtp(ownerPhone, approvalCode);
      } catch (error) {
        await this.db.pool.query('DELETE FROM staff_email_invitations WHERE id=$1', [saved.rows[0].id]);
        throw error;
      }
      return { approvalRequired: true, invitationId: saved.rows[0].id, ownerPhoneHint: ownerPhone.slice(-4),
        message: 'A six-digit approval code has been sent to the shop owner’s registered phone.' };
    }
    const apiKey = process.env.BREVO_API_KEY?.trim();
    const from = process.env.BREVO_FROM_EMAIL?.trim();
    if (!apiKey || !from) {
      await this.db.pool.query('DELETE FROM staff_email_invitations WHERE id=$1', [saved.rows[0].id]);
      throw new BadRequestException('Brevo email is not configured. Set BREVO_API_KEY and BREVO_FROM_EMAIL in the API hosting settings.');
    }
    const base = (process.env.PUBLIC_APP_URL || 'https://swass-web.onrender.com').replace(/\/$/,'');
    const inviteUrl = base + '/staff-invite.html?token=' + encodeURIComponent(token);
    const safeName = this.escape(fullName), safeRole = this.escape(jobTitle);
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#172033;padding:24px"><h2>Welcome to AURORA E-RECEIPT</h2><p>Hello ${safeName},</p><p>You have been invited to join the AURORA shop workspace as <strong>${safeRole}</strong>. You will have full workspace access except inviting other vendors or freelancers.</p><p>Use the secure button below to accept your invitation and create your own password. Your link expires in 7 days and can only be used once.</p><p><a href="${inviteUrl}" style="display:inline-block;background:#176bce;color:white;padding:14px 22px;border-radius:8px;text-decoration:none">Accept AURORA invitation</a></p><p>If you were not expecting this invitation, you can ignore this email.</p></div>`;
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'api-key': String(apiKey), 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: String(from), name: 'AURORA E-RECEIPT' },
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

  @Post('invitations/approve')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('owner')
  async approveInvitation(@Req() req: any, @Body() body: { invitationId?: string; code?: string }) {
    const id = String(body?.invitationId ?? '');
    const code = String(body?.code ?? '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(id) || !/^\d{6}$/.test(code)) throw new BadRequestException('Enter the six-digit approval code.');
    const result = await this.db.pool.query(
      `SELECT i.*,u.phone AS owner_phone FROM staff_email_invitations i
         JOIN users u ON u.id=i.created_by AND u.tenant_id=i.tenant_id
        WHERE i.id=$1 AND i.tenant_id=$2 AND i.store_id=$3 AND i.created_by=$4
          AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now()
          AND i.approval_expires_at>now() AND i.approval_attempts<5
        LIMIT 1`, [id,req.user.tenantId,req.user.storeId,req.user.sub],
    );
    const invite = result.rows[0];
    if (!invite) throw new BadRequestException('Approval request expired or was already used. Send a new invitation.');
    if (this.hash(code) !== invite.approval_code_hash) {
      await this.db.pool.query('UPDATE staff_email_invitations SET approval_attempts=approval_attempts+1 WHERE id=$1', [id]);
      throw new BadRequestException('The approval code is incorrect.');
    }
    const apiKey = process.env.BREVO_API_KEY?.trim();
    const from = process.env.BREVO_FROM_EMAIL?.trim();
    if (!apiKey || !from) throw new BadRequestException('Brevo email is not configured. Set BREVO_API_KEY and BREVO_FROM_EMAIL in the API hosting settings.');
    const base = (process.env.PUBLIC_APP_URL || 'https://swass-web.onrender.com').replace(/\/$/,'');
    const inviteUrl = base + '/staff-invite.html?token=' + encodeURIComponent(String(invite.token_hash ? '' : ''));
    // Recover the original invitation token is intentionally impossible from its hash; create a fresh one after approval.
    const token = randomBytes(32).toString('base64url');
    await this.db.pool.query('UPDATE staff_email_invitations SET token_hash=$1,approval_code_hash=NULL,approval_expires_at=NULL WHERE id=$2', [this.hash(token),id]);
    const safeName = this.escape(invite.full_name), safeRole = this.escape(invite.job_title);
    const secureUrl = base + '/staff-invite.html?token=' + encodeURIComponent(token);
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#172033;padding:24px"><h2>Welcome to AURORA E-RECEIPT</h2><p>Hello ${safeName},</p><p>You have been invited to join a shop workspace as <strong>${safeRole}</strong>. You will have access to the shop workspace except inviting other vendors or freelancers.</p><p>The shop owner approved this invitation using a code sent to their registered phone. Use the secure button below to create your own private password. The link expires in 7 days and can only be used once.</p><p><a href="${secureUrl}" style="display:inline-block;background:#176bce;color:white;padding:14px 22px;border-radius:8px;text-decoration:none">Create your AURORA password</a></p></div>`;
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'api-key': String(apiKey), 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { email: String(from), name: 'AURORA E-RECEIPT' }, to: [{ email: invite.email, name: invite.full_name }],
        subject: 'Your approved invitation to AURORA E-RECEIPT', htmlContent: html }),
    });
    const providerReply = await response.text();
    if (!response.ok) {
      console.error('[AURORA] Approved freelancer invitation email rejected:', response.status, providerReply.slice(0,180));
      throw new BadRequestException('Owner approval succeeded, but the invitation email could not be sent. Check the verified Brevo sender.');
    }
    return { approved: true, message: 'Owner approval confirmed. The freelancer invitation email has been sent.' };
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
