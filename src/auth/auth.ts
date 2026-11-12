import {
  BadRequestException, CanActivate, Controller, ExecutionContext, ForbiddenException, HttpException, HttpStatus, Injectable,
  Post, Body, Req, SetMetadata, UnauthorizedException, UseGuards, ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DbService } from '../db/db.service';
import { EmailVerificationService } from '../notifications/email-verification.service';

export type Role = 'super_admin' | 'owner' | 'manager' | 'cashier' | 'vendor' | 'freelancer' | 'customer';

export interface AuthUser {
  sub: string;
  tenantId: string | null;
  storeId: string | null;
  role: Role;
  mustChangePassword?: boolean;
  fullName?: string;
}

export const Roles = (...roles: Role[]) => SetMetadata('roles', roles);

/** Reads the Bearer token and attaches the user to the request. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private jwt: JwtService, private db: DbService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers['authorization'] ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException();
    try {
      req.user = (await this.jwt.verifyAsync(token)) as AuthUser;
    } catch {
      throw new UnauthorizedException();
    }

    const user = req.user as AuthUser;
    if (user.role === 'super_admin') {
      const allowed = (process.env.AURORA_ADMIN_EMAILS || '').split(',').map((v: string) => v.trim().toLowerCase()).filter(Boolean);
      const adminEmail = String((req.user as any).adminEmail || '').trim().toLowerCase();
      if (!adminEmail || !allowed.includes(adminEmail)) throw new ForbiddenException('This administrator account is not authorised.');
      const verified = await this.db.pool.query(
        `SELECT 1 FROM users WHERE id=$1 AND lower(email)=$2 AND is_active=true AND email_verified_at IS NOT NULL LIMIT 1`,
        [user.sub, adminEmail],
      );
      if (!verified.rowCount) throw new ForbiddenException('Administrator access is no longer active or the email is not verified.');
    }
    const path = String(req.originalUrl ?? req.url ?? '').split('?')[0];
    if (user.mustChangePassword && path !== '/api/v1/auth/change-password') throw new ForbiddenException('Please create your own password before using the shop workspace.');
    // Keep the payment portal usable when a subscription has expired or has
    // not yet been purchased. All business-operation APIs remain locked.
    const paymentRoute = path === '/api/v1/mpesa/stk-push' || path === '/api/v1/mpesa/account-summary' || path === '/api/v1/auth/change-password' ||
      /^\/api\/v1\/mpesa\/payments\/[0-9a-f-]+$/i.test(path);
    if (user.tenantId && user.role !== 'super_admin' && !paymentRoute) {
      const active = await this.db.pool.query(
        `SELECT 1 FROM subscriptions
          WHERE tenant_id=$1 AND status='active' AND ends_at>now()
          LIMIT 1`,
        [user.tenantId],
      );
      if (!active.rowCount) {
        throw new HttpException(
          'An active SWASS subscription is required. Pay KSh 100 for a monthly subscription or KSh 900 for a yearly subscription to unlock your business workspace.',
          HttpStatus.PAYMENT_REQUIRED,
        );
      }
    }
    return true;
  }
}

/** Allows the route only for the roles named with @Roles(). */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const allowed = this.reflector.get<Role[]>('roles', ctx.getHandler());
    if (!allowed) return true;
    const req = ctx.switchToHttp().getRequest();
    const user: AuthUser = req.user;
    if (!user) throw new ForbiddenException();
    // Vendors and freelancers share owner workspace permissions, except invitations.
    const path = String(req.originalUrl ?? req.url ?? '').split('?')[0];
    if ((user.role === 'vendor' || user.role === 'freelancer') && path.startsWith('/api/v1/staff/invitations')) throw new ForbiddenException();
    const isVendorWorkspace = user.role === 'vendor' || user.role === 'freelancer';
    const effectiveRole: Role = isVendorWorkspace ? 'owner' : user.role;
    if (!allowed.includes(effectiveRole) && !(isVendorWorkspace && allowed.some(role => role === 'vendor' || role === 'freelancer'))) throw new ForbiddenException();
    return true;
  }
}

@Controller('api/v1/auth')
export class AuthController {
  constructor(private db: DbService, private jwt: JwtService, private emailVerification: EmailVerificationService) {}

  private normalizePhone(value: string): string {
    const digits = value.replace(/\D/g, '');
    if (digits.startsWith('254') && digits.length === 12) return digits;
    if (digits.startsWith('0') && digits.length === 10) return '254' + digits.slice(1);
    if (digits.length === 9) return '254' + digits;
    throw new UnauthorizedException('Enter a valid Kenyan phone number');
  }

  private signupCodeHash(code: string): string {
    const secret = process.env.SWASS_ID_SECRET;
    if (!secret) throw new Error('SWASS_ID_SECRET is required');
    return createHmac('sha256', secret).update(`signup-otp:${code}`).digest('hex');
  }

  private async sendSignupSms(to: string, message: string): Promise<void> {
    const failures: string[] = [];
    const token = process.env.TALKSASA_API_TOKEN;

    // Try the approved TalkSasa sender first.
    if (token) {
      const providerStartedAt = Date.now();
      try {
        const configuredTalkSasaUrl = (process.env.TALKSASA_API_URL || 'https://bulksms.talksasa.com/api/v3/sms/send').trim();
        const talkSasaEndpoint = /\/sms\/send\/?$/i.test(configuredTalkSasaUrl)
          ? configuredTalkSasaUrl
          : `${configuredTalkSasaUrl.replace(/\/+$/, '')}/sms/send`;
        const response = await fetch(talkSasaEndpoint, {
          method: 'POST',
          signal: AbortSignal.timeout(12000),
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: `+${to}`,
            sender_id: process.env.TALKSASA_SENDER_ID || 'TALK-SASA',
            type: 'plain',
            message,
          }),
        });
        const raw = await response.text();
        let result: any = {};
        try { result = raw ? JSON.parse(raw) : {}; } catch { result = {}; }
        // Log timing and provider acceptance only; never log the phone, OTP, token or message.
        const gatewayStatus = String(result?.status ?? result?.data?.status ?? '').trim().toLowerCase();
        const accepted = response.ok && (
          gatewayStatus === 'success' || gatewayStatus === 'accepted' || gatewayStatus === 'queued' ||
          result?.success === true || result?.status === true
        );
        console.info(`[SWASS] Signup OTP TalkSasa response: HTTP ${response.status}, status=${gatewayStatus || 'missing'}, accepted=${accepted}, durationMs=${Date.now() - providerStartedAt}`);
        // Do not treat HTTP 200 alone as success: the gateway can return a JSON error.
        if (accepted) return;
        const reason = String(result?.message ?? result?.error ?? result?.data?.message ?? raw ?? response.statusText ?? '').replace(/[\\r\\n]+/g, ' ').slice(0, 180);
        failures.push(`TalkSasa HTTP ${response.status}${reason ? `: ${reason}` : ''}`);
      } catch (error) {
        console.warn(`[SWASS] Signup OTP TalkSasa request failed after ${Date.now() - providerStartedAt}ms: ${error instanceof Error ? error.name : 'request failed'}`);
        failures.push(`TalkSasa: ${error instanceof Error ? error.message : 'request failed'}`);
      }
    }

    // Keep the previously supported Africa's Talking route as a real fallback.
    const atUsername = process.env.AT_USERNAME;
    const atApiKey = process.env.AT_API_KEY;
    if (atUsername && atApiKey) {
      try {
        const form = new URLSearchParams({ username: atUsername, to: `+${to}`, message });
        if (process.env.AT_SENDER_ID) form.set('from', process.env.AT_SENDER_ID);
        const endpoint = atUsername === 'sandbox'
          ? 'https://api.sandbox.africastalking.com/version1/messaging'
          : 'https://api.africastalking.com/version1/messaging';
        const response = await fetch(endpoint, {
          method: 'POST',
          signal: AbortSignal.timeout(12000),
          headers: { apiKey: atApiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form,
        });
        const raw = await response.text();
        let result: any = {};
        try { result = raw ? JSON.parse(raw) : {}; } catch { result = {}; }
        const recipients = result?.SMSMessageData?.Recipients;
        if (response.ok && Array.isArray(recipients) && recipients.length &&
            recipients.every((r: any) => Number(r.statusCode) === 101)) return;
        const providerMessage = String(result?.SMSMessageData?.Message ?? result?.message ?? raw ?? '').slice(0, 140);
        failures.push(`Africa's Talking HTTP ${response.status}${providerMessage ? `: ${providerMessage}` : ''}`);
      } catch (error) {
        failures.push(`Africa's Talking: ${error instanceof Error ? error.message : 'request failed'}`);
      }
    }

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const auth = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM || process.env.TWILIO_FROM_NUMBER;
    if (sid && auth && from) {
      try {
        const form = new URLSearchParams({ To: `+${to}`, From: from, Body: message });
        const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: 'POST',
          signal: AbortSignal.timeout(12000),
          headers: {
            Authorization: `Basic ${Buffer.from(`${sid}:${auth}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form,
        });
        if (response.ok) return;
        failures.push(`Twilio HTTP ${response.status}`);
      } catch (error) {
        failures.push(`Twilio: ${error instanceof Error ? error.message : 'request failed'}`);
      }
    }

    if (!token && !atUsername && !sid) {
      if (process.env.NODE_ENV !== 'production') return;
      throw new Error('No SMS provider credentials are configured');
    }
    throw new Error(failures.join(' | ') || 'All configured SMS providers failed');
  }

  @Post('register')
  async register(@Body() body: { accountType?: string; businessName?: string; storeName?: string; storeLocation?: string; houseName?: string; floor?: string; houseNumber?: string; websiteUrl?: string; kraPin?: string; legalName?: string; businessEmail?: string; fullName?: string; phone?: string; email?: string; password?: string; referralCode?: string }, @Req() req: any) {
    const registrationStartedAt = Date.now();
    console.info('[SWASS][OTP_DIAG] Signup registration request received');
    if (body?.accountType === 'cashier') throw new BadRequestException('Staff accounts can only be created by accepting an email invitation from the shop owner.');
    const role = 'owner';
    const invitationId: string | null = null;
    let businessName = body?.businessName?.trim() || '';
    let storeName = (body?.storeName || body?.businessName)?.trim() || '';
    let storeLocation = body?.storeLocation?.trim() || null;
    const houseName=body?.houseName?.trim()||null; const floor=body?.floor?.trim()||null; const houseNumber=body?.houseNumber?.trim()||null; const websiteUrl=body?.websiteUrl?.trim()||null; const kraPin=body?.kraPin?.trim()||null; const legalName=body?.legalName?.trim()||null; const businessEmail=body?.businessEmail?.trim().toLowerCase()||null;
    if(legalName && legalName.length>160) throw new BadRequestException('Legal entity name is too long');
    if(businessEmail && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(businessEmail)||businessEmail.length>254)) throw new BadRequestException('Enter a valid business email address');
    if(websiteUrl && (websiteUrl.length>255 || !/^https?:\/\//i.test(websiteUrl))) throw new BadRequestException('Enter a valid website URL beginning with http:// or https://');
    if(kraPin && kraPin.length>40) throw new BadRequestException('KRA PIN is too long');
    const fullName = body?.fullName?.trim();
    const email = body?.email?.trim().toLowerCase() || null;
    const password = body?.password || '';
    if (!businessName || businessName.length > 120 || !storeName || storeName.length > 120 || !fullName || fullName.length > 120) {
      throw new BadRequestException('Enter your business name, store name and full name (maximum 120 characters each)');
    }
    if (storeLocation && storeLocation.length > 200) throw new BadRequestException('Store location must be at most 200 characters');
    if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) throw new BadRequestException('Enter a valid email address');
    if (password.length < 10 || password.length > 128) throw new BadRequestException('Password must be at least 10 characters');
    const phone = this.normalizePhone(body.phone || '');
    const referralCode = String(body.referralCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20) || null;
    const ip = String(req.ip ?? '').replace(/^::ffff:/, '') || null;

    // Run independent database checks and password hashing together to shorten signup time.
    const checksStartedAt = Date.now();
    const [existing, limits, passwordHash] = await Promise.all([
      this.db.pool.query(`SELECT 1 FROM users WHERE phone = ANY($1::text[]) OR regexp_replace(phone, '[^0-9]', '', 'g') = ANY($1::text[]) LIMIT 1`, [[phone, '0' + phone.slice(3)]]),
      this.db.pool.query(
        `SELECT
          (SELECT count(*)::int FROM signup_otp_requests WHERE phone=$1 AND created_at>now()-interval '15 minutes') AS phone_count,
          (SELECT count(*)::int FROM signup_otp_requests WHERE ip_address=$2::inet AND created_at>now()-interval '15 minutes') AS ip_count`,
        [phone, ip],
      ),
      argon2.hash(password),
    ]);
    console.info(`[SWASS][OTP_DIAG] Signup validation, database checks and password hash completed in ${Date.now() - checksStartedAt}ms`);
    if (existing.rowCount) throw new UnauthorizedException('This phone number is already registered. Sign in or use another number.');
    if (limits.rows[0].phone_count >= 3 || limits.rows[0].ip_count >= 10) {
      throw new BadRequestException('Too many OTP requests. Please wait 15 minutes before trying again.');
    }
    const code = String(randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, '0');
    const saveOtpStartedAt = Date.now();
    await this.db.pool.query(
      `UPDATE signup_otp_requests SET expires_at=now()
       WHERE phone=$1 AND verified_at IS NULL AND consumed_at IS NULL AND expires_at>now()`,
      [phone],
    );
    const saved = await this.db.pool.query(
      `INSERT INTO signup_otp_requests
       (phone,business_name,store_name,store_location,full_name,email,password_hash,code_hash,ip_address,expires_at,role,invitation_id,house_name,floor,house_number,website_url,kra_pin,legal_name,business_email,referral_code)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::inet,now()+interval '5 minutes',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
      [phone,businessName,storeName,storeLocation,fullName,email,passwordHash,this.signupCodeHash(code),ip,role,invitationId,houseName,floor,houseNumber,websiteUrl,kraPin,legalName,businessEmail,referralCode],
    );
    console.info(`[SWASS][OTP_DIAG] OTP record saved in ${Date.now() - saveOtpStartedAt}ms; starting SMS provider request`);
    try {
      await this.sendSignupSms(phone, `Your SWASS signup verification code is ${code}. It expires in 5 minutes. Do not share this code.`);
      console.info(`[SWASS][OTP_DIAG] SMS provider accepted signup OTP; total registration duration ${Date.now() - registrationStartedAt}ms`);
    } catch (error) {
      await this.db.pool.query('UPDATE signup_otp_requests SET expires_at=now() WHERE id=$1', [saved.rows[0].id]);
      const reason = (error instanceof Error ? error.message : 'SMS provider error').replace(/[\\r\\n]+/g, ' ').slice(0, 220);
      console.error(`[SWASS][OTP_DIAG] Signup OTP delivery failed after ${Date.now() - registrationStartedAt}ms:`, reason);
      throw new ServiceUnavailableException(`We could not send your verification code. SMS gateway response: ${reason}`);
    }
    return process.env.NODE_ENV === 'production'
      ? { otpRequired: true, expiresInSeconds: 300, message: 'A 6-digit verification code has been sent to your phone.' }
      : { otpRequired: true, expiresInSeconds: 300, message: 'A 6-digit verification code has been sent to your phone.', developmentCode: code };
  }

  @Post('register/verify-otp')
  async verifySignupOtp(@Body() body: { phone?: string; code?: string }) {
    if (!body?.phone || !/^\d{6}$/.test(String(body?.code ?? '').trim())) {
      throw new BadRequestException('Enter your phone number and the 6-digit code sent by SMS.');
    }
    const phone = this.normalizePhone(body.phone);
    const code = String(body.code).trim();
    const pending = await this.db.pool.query(
      `SELECT * FROM signup_otp_requests
       WHERE phone=$1 AND verified_at IS NULL AND consumed_at IS NULL AND expires_at>now()
       ORDER BY created_at DESC LIMIT 1`,
      [phone],
    );
    const row = pending.rows[0];
    if (!row || Number(row.attempts) >= 5) throw new BadRequestException('Code is invalid or expired. Request a new code.');
    const supplied = Buffer.from(this.signupCodeHash(code), 'hex');
    const expected = Buffer.from(row.code_hash, 'hex');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      await this.db.pool.query('UPDATE signup_otp_requests SET attempts=attempts+1 WHERE id=$1 AND attempts<5', [row.id]);
      throw new BadRequestException('That code is incorrect. Check the SMS and try again.');
    }

    try {
      const user = await this.db.tx(async c => {
        const locked = await c.query(
          `SELECT * FROM signup_otp_requests
           WHERE id=$1 AND verified_at IS NULL AND consumed_at IS NULL AND expires_at>now()
           FOR UPDATE`, [row.id],
        );
        if (!locked.rowCount || Number(locked.rows[0].attempts) >= 5) throw new BadRequestException('Code is invalid or expired. Request a new code.');
        let tenantId: string;
        let storeId: string;
        let inserted: any;
        if (row.role === 'cashier') {
          const invite = await c.query(
            `SELECT id,tenant_id,store_id FROM staff_invitations
              WHERE id=$1 AND accepted_by IS NULL AND revoked_at IS NULL AND expires_at>now()
              FOR UPDATE`, [row.invitation_id],
          );
          if (!invite.rowCount) throw new BadRequestException('This invitation has already been used or has expired. Ask the owner for a new code.');
          tenantId = invite.rows[0].tenant_id;
          storeId = invite.rows[0].store_id;
          inserted = await c.query(
            `INSERT INTO users (tenant_id,store_id,full_name,phone,email,password_hash,role,must_change_password)
             VALUES ($1,$2,$3,$4,$5,$6,'cashier',true) RETURNING id,tenant_id,store_id,role`,
            [tenantId,storeId,row.full_name,phone,row.email,row.password_hash],
          );
          await c.query('UPDATE staff_invitations SET accepted_by=$1 WHERE id=$2', [inserted.rows[0].id,row.invitation_id]);
        } else {
          const tenant = await c.query(
            'INSERT INTO tenants (name, phone, email, website_url, kra_pin, legal_name) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
            [row.business_name, phone, row.business_email || row.email, row.website_url, row.kra_pin, row.legal_name],
          );
          tenantId = tenant.rows[0].id;
          const store = await c.query(
            'INSERT INTO stores (tenant_id,name,location,house_name,floor,house_number) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
            [tenantId, row.store_name, row.store_location, row.house_name, row.floor, row.house_number],
          );
          storeId = store.rows[0].id;
          inserted = await c.query(
            `INSERT INTO users (tenant_id,store_id,full_name,phone,email,password_hash,role)
             VALUES ($1,$2,$3,$4,$5,$6,'owner') RETURNING id,tenant_id,store_id,role`,
            [tenantId,storeId,row.full_name,phone,row.email,row.password_hash],
          );
          await c.query('INSERT INTO wallets (tenant_id) VALUES ($1)', [tenantId]);
          if (row.referral_code) {
            const referrer = await c.query('SELECT id FROM tenants WHERE referral_code=$1 FOR UPDATE', [row.referral_code]);
            if (referrer.rowCount && referrer.rows[0].id !== tenantId) {
              await c.query(
                'INSERT INTO tenant_referrals(referrer_tenant_id,referred_tenant_id,referral_code) VALUES($1,$2,$3) ON CONFLICT (referred_tenant_id) DO NOTHING',
                [referrer.rows[0].id, tenantId, row.referral_code],
              );
            }
          }
        }
        // New accounts remain locked until the owner completes a paid subscription.
        await c.query('UPDATE signup_otp_requests SET verified_at=now(),consumed_at=now() WHERE id=$1', [row.id]);
        return inserted.rows[0];
      });
      const payload: AuthUser = { sub: user.id, tenantId: user.tenant_id, storeId: user.store_id, role: user.role, mustChangePassword: row.role === 'cashier' };
      // Complete account creation without waiting for the external email provider.
      // Email verification continues independently after the account is ready.
      if (row.email) {
        void this.emailVerification.send(user.id, row.email, row.full_name)
          .catch(error => console.error('[SWASS] Welcome email delivery failed:', error instanceof Error ? error.message : error));
      }
      return {
        accessToken: await this.jwt.signAsync(payload, { expiresIn: '30d' }),
        trialDays: 0, phoneVerified: true,
        emailVerificationSent: false, emailVerificationRequired: !!row.email,
        mustChangePassword: row.role === 'cashier',
      };
    } catch (err: any) {
      if (err?.code === '23505') throw new UnauthorizedException('This phone number is already registered. Sign in or use another number.');
      throw err;
    }
  }

  @Post('email-verification/verify')
  async verifyEmail(@Body() body: { token?: string }) {
    return this.emailVerification.verify(String(body?.token ?? ''));
  }

  @Post('admin/login')
  async adminLogin(@Body() body: { email?: string; password?: string }) {
    const email = String(body?.email || '').trim().toLowerCase();
    const password = String(body?.password || '');
    const allowed = (process.env.AURORA_ADMIN_EMAILS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
    if (!email || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) || !password || password.length > 128 || !allowed.includes(email)) {
      throw new UnauthorizedException('Invalid administrator email or password.');
    }
    const found = await this.db.pool.query(
      `SELECT id,full_name,email,password_hash,is_active,email_verified_at
         FROM users WHERE lower(email)=$1 LIMIT 1`, [email],
    );
    const account = found.rows[0];
    let passwordOk = false;
    if (account?.password_hash) {
      try { passwordOk = await argon2.verify(account.password_hash, password); } catch { passwordOk = false; }
    }
    if (!account || !account.is_active || !account.email_verified_at || !passwordOk) {
      throw new UnauthorizedException('Invalid administrator email or password, or email verification is still pending.');
    }
    const payload: AuthUser & { adminEmail: string } = {
      sub: account.id, tenantId: null, storeId: null, role: 'super_admin',
      fullName: account.full_name, adminEmail: email,
    };
    return {
      accessToken: await this.jwt.signAsync(payload, { expiresIn: '8h' }),
      user: { fullName: account.full_name, role: 'super_admin', email },
    };
  }

  @Post('bootstrap-admin')
  async bootstrapAdmin(@Req() req: any, @Body() body: { fullName?: string; phone?: string; email?: string; password?: string }) {
    const configured = process.env.SWASS_ADMIN_BOOTSTRAP_TOKEN ?? '';
    const supplied = String(req.headers['x-swass-bootstrap-token'] ?? '');
    if (!configured || !supplied || supplied.length > 256 ||
        !timingSafeEqual(createHash('sha256').update(configured).digest(), createHash('sha256').update(supplied).digest())) {
      throw new UnauthorizedException('Admin bootstrap is not authorized');
    }
    const fullName = body?.fullName?.trim();
    const phone = this.normalizePhone(body?.phone || '');
    const email = body?.email?.trim().toLowerCase() || null;
    const password = body?.password || '';
    if (!fullName || fullName.length > 120) throw new UnauthorizedException('Enter a valid administrator name');
    if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) throw new UnauthorizedException('Enter a valid email address');
    if (password.length < 12 || password.length > 128) throw new UnauthorizedException('Administrator password must be at least 12 characters');
    const passwordHash = await argon2.hash(password);
    const admin = await this.db.tx(async client => {
      await client.query('SELECT pg_advisory_xact_lock(731904221)');
      const existing = await client.query("SELECT id FROM users WHERE role='super_admin' LIMIT 1");
      if (existing.rowCount) throw new UnauthorizedException('A company administrator is already configured');
      const inserted = await client.query(
        "INSERT INTO users (tenant_id,store_id,full_name,phone,email,password_hash,role) VALUES (NULL,NULL,$1,$2,$3,$4,'super_admin') RETURNING id,role",
        [fullName, phone, email, passwordHash],
      );
      return inserted.rows[0];
    });
    return { created: true, role: admin.role, message: 'Company administrator created. Sign in using the normal login endpoint.' };
  }


  private passwordResetCodeHash(code: string): string {
    const secret = process.env.SWASS_ID_SECRET;
    if (!secret) throw new Error('SWASS_ID_SECRET is required');
    return createHmac('sha256', secret).update(`password-reset:${code}`).digest('hex');
  }

  @Post('password-reset/request')
  async requestPasswordReset(@Body() body: { phone?: string; accountType?: string }) {
    const phone = this.normalizePhone(String(body?.phone ?? ''));
    const generic = { message: 'If an account matches that phone number, a password reset code has been sent.' };
    const found = await this.db.pool.query(
      `SELECT id FROM users
         WHERE regexp_replace(phone, '[^0-9]', '', 'g') IN ($1,$2)
           AND is_active=true
           AND ($3::text IS NULL OR role=$3)
         LIMIT 1`,
      [phone, '0' + phone.slice(3), body?.accountType === 'freelancer' ? 'freelancer' : null],
    );
    console.info(`[AURORA] Freelancer password-reset lookup: matched=${Boolean(found.rowCount)}, accountType=${body?.accountType === 'freelancer' ? 'freelancer' : 'other'}`);
    if (!found.rowCount) return generic;
    const userId = found.rows[0].id;
    const recent = await this.db.pool.query(
      `SELECT count(*)::int AS n FROM password_reset_requests
       WHERE user_id=$1 AND created_at>now()-interval '15 minutes'`, [userId],
    );
    if (Number(recent.rows[0].n) >= 4) {
      throw new BadRequestException('Too many reset requests. Please wait 15 minutes and try again.');
    }
    const code = String(randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, '0');
    await this.db.pool.query(
      `UPDATE password_reset_requests SET used_at=now()
       WHERE user_id=$1 AND used_at IS NULL AND expires_at>now()`, [userId],
    );
    const saved = await this.db.pool.query(
      `INSERT INTO password_reset_requests(user_id,phone,code_hash,expires_at)
       VALUES($1,$2,$3,now()+interval '5 minutes') RETURNING id`,
      [userId, phone, this.passwordResetCodeHash(code)],
    );
    try {
      await this.sendSignupSms(phone, `Your SWASS password reset code is ${code}. It expires in 5 minutes. Do not share this code.`);
    } catch (error) {
      await this.db.pool.query('UPDATE password_reset_requests SET expires_at=now() WHERE id=$1', [saved.rows[0].id]);
      const reason = (error instanceof Error ? error.message : 'SMS provider error').replace(/[\\r\\n]+/g, ' ').slice(0, 180);
      console.error('[AURORA] Freelancer password-reset SMS delivery failed:', reason);
      throw new ServiceUnavailableException('The SMS gateway could not send your reset code. Please check the phone number and try again, or contact support.');
    }
    return generic;
  }

  @Post('password-reset/confirm')
  async confirmPasswordReset(@Body() body: { phone?: string; code?: string; newPassword?: string; accountType?: string }) {
    const phone = this.normalizePhone(String(body?.phone ?? ''));
    const code = String(body?.code ?? '').trim();
    const newPassword = String(body?.newPassword ?? '');
    if (!/^\d{6}$/.test(code)) throw new BadRequestException('Enter the six-digit reset code.');
    if (newPassword.length < 10 || newPassword.length > 128) {
      throw new BadRequestException('New password must be at least 10 characters.');
    }
    const pending = await this.db.pool.query(
      `SELECT pr.id,pr.user_id,pr.code_hash,pr.attempts
       FROM password_reset_requests pr JOIN users u ON u.id=pr.user_id
       WHERE pr.phone=$1 AND pr.used_at IS NULL AND pr.expires_at>now() AND u.is_active=true
         AND ($2::text IS NULL OR u.role=$2)
       ORDER BY pr.created_at DESC LIMIT 1`,
      [phone, body?.accountType === 'freelancer' ? 'freelancer' : null],
    );
    const row = pending.rows[0];
    if (!row || Number(row.attempts) >= 5) throw new BadRequestException('Reset code is invalid or expired. Request a new code.');
    const supplied = Buffer.from(this.passwordResetCodeHash(code), 'hex');
    const expected = Buffer.from(row.code_hash, 'hex');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      await this.db.pool.query('UPDATE password_reset_requests SET attempts=attempts+1 WHERE id=$1 AND attempts<5', [row.id]);
      throw new BadRequestException('That reset code is incorrect. Try again.');
    }
    const passwordHash = await argon2.hash(newPassword);
    await this.db.tx(async c => {
      const locked = await c.query(
        `SELECT id FROM password_reset_requests
         WHERE id=$1 AND used_at IS NULL AND expires_at>now() AND attempts<5 FOR UPDATE`, [row.id],
      );
      if (!locked.rowCount) throw new BadRequestException('Reset code has expired. Request a new one.');
      await c.query('UPDATE users SET password_hash=$1 WHERE id=$2', [passwordHash, row.user_id]);
      await c.query('UPDATE password_reset_requests SET used_at=now() WHERE id=$1', [row.id]);
      await c.query(
        'UPDATE password_reset_requests SET used_at=now() WHERE user_id=$1 AND id<>$2 AND used_at IS NULL',
        [row.user_id, row.id],
      );
    });
    return { reset: true, message: 'Password updated. You can now sign in with your new password.' };
  }

  @Post('change-password')
  @UseGuards(AuthGuard)
  async changePassword(@Req() req: any, @Body() body: { newPassword?: string }) {
    const password = String(body?.newPassword ?? '');
    if (password.length < 10 || password.length > 128) throw new BadRequestException('New password must be at least 10 characters.');
    const hash = await argon2.hash(password);
    await this.db.pool.query('UPDATE users SET password_hash=$1,must_change_password=false WHERE id=$2', [hash, req.user.sub]);
    return { changed: true, message: 'Your password has been created. Please sign in again using it.' };
  }

  @Post('customer/register')
  async registerCustomer(@Body() body: { fullName?: string; phone?: string; email?: string; password?: string; referralCode?: string }, @Req() req: any) {
    const fullName = String(body?.fullName ?? '').trim();
    const phone = this.normalizePhone(String(body?.phone ?? ''));
    const email = String(body?.email ?? '').trim().toLowerCase() || null;
    const password = String(body?.password ?? '');
    const referralCode = String(body?.referralCode ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,20) || null;
    if (!fullName || fullName.length > 120) throw new BadRequestException('Enter your full name (maximum 120 characters).');
    if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) throw new BadRequestException('Enter a valid email address.');
    if (password.length < 10 || password.length > 128) throw new BadRequestException('Password must be at least 10 characters.');
    const existing = await this.db.pool.query('SELECT 1 FROM customer_accounts WHERE phone=$1 LIMIT 1', [phone]);
    if (existing.rowCount) throw new BadRequestException('A customer account already exists for this phone. Please sign in.');
    const limits = await this.db.pool.query(
      `SELECT count(*)::int AS n FROM customer_signup_otp_requests WHERE phone=$1 AND created_at>now()-interval '15 minutes'`,
      [phone],
    );
    if (Number(limits.rows[0]?.n ?? 0) >= 3) throw new BadRequestException('Too many verification requests. Please wait 15 minutes.');
    const passwordHash = await argon2.hash(password);
    const code = String(randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, '0');
    await this.db.pool.query(
      `UPDATE customer_signup_otp_requests SET expires_at=now() WHERE phone=$1 AND consumed_at IS NULL AND expires_at>now()`, [phone],
    );
    const saved = await this.db.pool.query(
      `INSERT INTO customer_signup_otp_requests(phone,full_name,email,password_hash,code_hash,expires_at,referral_code)
       VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes',$6) RETURNING id`,
      [phone,fullName,email,passwordHash,this.signupCodeHash(code),referralCode],
    );
    try {
      await this.sendSignupSms(phone, `Your AURORA customer verification code is ${code}. It expires in 5 minutes. Do not share this code.`);
    } catch (error) {
      await this.db.pool.query('UPDATE customer_signup_otp_requests SET expires_at=now() WHERE id=$1', [saved.rows[0].id]);
      const reason = (error instanceof Error ? error.message : 'Unknown SMS provider error').replace(/[\\r\\n]+/g, ' ').slice(0, 220);
      console.error('[AURORA] Customer signup SMS delivery failed:', reason);
      throw new ServiceUnavailableException(`We could not send your verification code. SMS gateway response: ${reason}`);
    }
    return process.env.NODE_ENV === 'production'
      ? { otpRequired: true, expiresInSeconds: 300, message: 'A verification code has been sent to your phone.' }
      : { otpRequired: true, expiresInSeconds: 300, developmentCode: code };
  }

  @Post('customer/register/verify-otp')
  async verifyCustomerSignupOtp(@Body() body: { phone?: string; code?: string }) {
    if (!body?.phone || !/^\d{6}$/.test(String(body?.code ?? '').trim())) throw new BadRequestException('Enter your phone number and the six-digit code.');
    const phone = this.normalizePhone(body.phone);
    const pending = await this.db.pool.query(
      `SELECT * FROM customer_signup_otp_requests WHERE phone=$1 AND consumed_at IS NULL AND expires_at>now()
       ORDER BY created_at DESC LIMIT 1`, [phone],
    );
    const row = pending.rows[0];
    if (!row || Number(row.attempts) >= 5) throw new BadRequestException('Code is invalid or expired. Request a new code.');
    const supplied = Buffer.from(this.signupCodeHash(String(body.code).trim()), 'hex');
    const expected = Buffer.from(row.code_hash, 'hex');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      await this.db.pool.query('UPDATE customer_signup_otp_requests SET attempts=attempts+1 WHERE id=$1 AND attempts<5', [row.id]);
      throw new BadRequestException('That code is incorrect. Check the SMS and try again.');
    }
    const account = await this.db.tx(async c => {
      const locked = await c.query(
        `SELECT * FROM customer_signup_otp_requests WHERE id=$1 AND consumed_at IS NULL AND expires_at>now() AND attempts<5 FOR UPDATE`, [row.id],
      );
      if (!locked.rowCount) throw new BadRequestException('Code has expired. Request a new one.');
      const created = await c.query(
        `INSERT INTO customer_accounts(full_name,phone,email,password_hash,referral_code)
         VALUES($1,$2,$3,$4,$5) RETURNING id,full_name,phone,email`,
        [row.full_name,row.phone,row.email,row.password_hash,randomBytes(6).toString('hex').toUpperCase()],
      );
      if(row.referral_code){
        const referrer=await c.query('SELECT id FROM customer_accounts WHERE referral_code=$1 FOR UPDATE',[row.referral_code]);
        if(referrer.rowCount && referrer.rows[0].id!==created.rows[0].id){
          await c.query('INSERT INTO customer_referrals(referrer_customer_id,referred_customer_id,referral_code) VALUES($1,$2,$3) ON CONFLICT(referred_customer_id) DO NOTHING',[referrer.rows[0].id,created.rows[0].id,row.referral_code]);
        }
      }
      await c.query('UPDATE customer_signup_otp_requests SET consumed_at=now() WHERE id=$1', [row.id]);
      return created.rows[0];
    });
    const payload: AuthUser = { sub: account.id, tenantId: null, storeId: null, role: 'customer', fullName: account.full_name };
    return { accessToken: await this.jwt.signAsync(payload, { expiresIn: '30d' }), phoneVerified: true, user: { fullName: account.full_name, phone: account.phone, email: account.email, role: 'customer' } };
  }

  @Post('login')
  async login(@Body() body: { phone?: string; password?: string; accountType?: string }) {
    const { password } = body ?? {};
    if (!body?.phone || !password) throw new UnauthorizedException();
    const phone = this.normalizePhone(body.phone);

    if (body.accountType === 'customer') {
      const customer = await this.db.pool.query(
        `SELECT id,full_name,phone,email,password_hash,is_active FROM customer_accounts WHERE phone=$1 LIMIT 1`, [phone],
      );
      const account = customer.rows[0];
      let passwordOk = false;
      if (account?.password_hash) {
        try { passwordOk = await argon2.verify(account.password_hash, password); } catch { passwordOk = false; }
      }
      if (!account || !account.is_active || !passwordOk) throw new UnauthorizedException('Invalid customer phone number or password.');
      const payload: AuthUser = { sub: account.id, tenantId: null, storeId: null, role: 'customer', fullName: account.full_name };
      return { accessToken: await this.jwt.signAsync(payload, { expiresIn: '30d' }), user: { fullName: account.full_name, phone: account.phone, email: account.email, role: 'customer' } };
    }

    const localPhone = '0' + phone.slice(3);
    const phoneVariants = [phone, localPhone];
    const requestedType = body.accountType === 'freelancer' ? 'freelancer' : body.accountType === 'staff' ? 'staff' : 'owner';
    const { rows } = await this.db.pool.query(
      `SELECT u.id, u.tenant_id, u.store_id, u.role, u.full_name, u.staff_title, u.profile_photo_data, u.password_hash, u.is_active, u.must_change_password, t.status AS tenant_status
         FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
        WHERE (u.phone = ANY($1::text[])
           OR regexp_replace(u.phone, '[^0-9]', '', 'g') = ANY($1::text[]))
          AND CASE
            WHEN $3='freelancer' THEN u.role='freelancer'
            WHEN $3='staff' THEN u.role IN ('cashier','vendor','freelancer')
            ELSE u.role IN ('owner','manager')
          END
        ORDER BY CASE WHEN u.phone = $2 THEN 0 ELSE 1 END
        LIMIT 1`,
      [phoneVariants, phone, requestedType],
    );
    const u = rows[0];
    // Same error for unknown phone, wrong password or disabled account.
    let passwordOk = false;
    if (u?.password_hash) {
      try { passwordOk = await argon2.verify(u.password_hash, password); } catch { passwordOk = false; }
    }
    const tenantIsUsable = !u?.tenant_id || u.tenant_status === 'active';
    const ok = u && u.is_active && tenantIsUsable && passwordOk;
    const roleMatches = requestedType === 'freelancer' ? u?.role === 'freelancer' : requestedType === 'staff' ? ['cashier','vendor','freelancer'].includes(u?.role) : ['owner','manager'].includes(u?.role);
    if (!ok || !roleMatches) throw new UnauthorizedException('Invalid phone or password for this sign-in type');

    const payload: AuthUser = { sub: u.id, tenantId: u.tenant_id, storeId: u.store_id, role: u.role, mustChangePassword: !!u.must_change_password, fullName: u.full_name };
    return { accessToken: await this.jwt.signAsync(payload, { expiresIn: '30d' }), mustChangePassword: !!u.must_change_password, user: { fullName: u.full_name, role: u.role, staffTitle: u.staff_title, profilePhotoData: u.profile_photo_data } };
  }
}
