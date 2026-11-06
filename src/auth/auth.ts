import {
  BadRequestException, CanActivate, Controller, ExecutionContext, ForbiddenException, Injectable,
  Post, Body, Req, SetMetadata, UnauthorizedException, UseGuards, ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DbService } from '../db/db.service';
import { EmailVerificationService } from '../notifications/email-verification.service';

export type Role = 'super_admin' | 'owner' | 'manager' | 'cashier';

export interface AuthUser {
  sub: string;
  tenantId: string | null;
  storeId: string | null;
  role: Role;
}

export const Roles = (...roles: Role[]) => SetMetadata('roles', roles);

/** Reads the Bearer token and attaches the user to the request. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private jwt: JwtService) {}

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
    const user: AuthUser = ctx.switchToHttp().getRequest().user;
    if (!user || !allowed.includes(user.role)) throw new ForbiddenException();
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
        const response = await fetch(process.env.TALKSASA_API_URL || 'https://bulksms.talksasa.com/api/v3/sms/send', {
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
        const accepted = response.ok && (result?.status === 'success' || result?.success === true);
        console.info(`[SWASS] Signup OTP TalkSasa response: HTTP ${response.status}, accepted=${accepted}, durationMs=${Date.now() - providerStartedAt}`);
        // The gateway returns status:"success" or status:"error"; HTTP 200 alone is not acceptance.
        if (accepted) return;
        const reason = String(result?.message ?? result?.error ?? raw ?? '').slice(0, 140);
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
  async register(@Body() body: { businessName?: string; storeName?: string; storeLocation?: string; fullName?: string; phone?: string; email?: string; password?: string }, @Req() req: any) {
    const registrationStartedAt = Date.now();
    console.info('[SWASS][OTP_DIAG] Signup registration request received');
    const businessName = body?.businessName?.trim();
    const storeName = (body?.storeName || body?.businessName)?.trim();
    const storeLocation = body?.storeLocation?.trim() || null;
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
       (phone,business_name,store_name,store_location,full_name,email,password_hash,code_hash,ip_address,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::inet,now()+interval '5 minutes') RETURNING id`,
      [phone,businessName,storeName,storeLocation,fullName,email,passwordHash,this.signupCodeHash(code),ip],
    );
    console.info(`[SWASS][OTP_DIAG] OTP record saved in ${Date.now() - saveOtpStartedAt}ms; starting SMS provider request`);
    try {
      await this.sendSignupSms(phone, `Your SWASS signup verification code is ${code}. It expires in 5 minutes. Do not share this code.`);
      console.info(`[SWASS][OTP_DIAG] SMS provider accepted signup OTP; total registration duration ${Date.now() - registrationStartedAt}ms`);
    } catch (error) {
      await this.db.pool.query('UPDATE signup_otp_requests SET expires_at=now() WHERE id=$1', [saved.rows[0].id]);
      const reason = error instanceof Error ? error.message : 'SMS provider error';
      console.error(`[SWASS][OTP_DIAG] Signup OTP delivery failed after ${Date.now() - registrationStartedAt}ms:`, reason);
      throw new ServiceUnavailableException('We could not send your verification code. Please check the phone number and try again.');
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
        const tenant = await c.query(
          'INSERT INTO tenants (name, phone, email) VALUES ($1,$2,$3) RETURNING id',
          [row.business_name, phone, row.email],
        );
        const tenantId = tenant.rows[0].id;
        const store = await c.query(
          'INSERT INTO stores (tenant_id,name,location) VALUES ($1,$2,$3) RETURNING id',
          [tenantId, row.store_name, row.store_location],
        );
        const inserted = await c.query(
          `INSERT INTO users (tenant_id,store_id,full_name,phone,email,password_hash,role)
           VALUES ($1,$2,$3,$4,$5,$6,'owner') RETURNING id,tenant_id,store_id,role`,
          [tenantId,store.rows[0].id,row.full_name,phone,row.email,row.password_hash],
        );
        await c.query('INSERT INTO wallets (tenant_id) VALUES ($1)', [tenantId]);
        await c.query(
          `INSERT INTO subscriptions (tenant_id,plan,price_kes,starts_at,ends_at,status,auto_renew)
           VALUES ($1,'monthly',100,now(),now()+interval '7 days','active',false)`,
          [tenantId],
        );
        await c.query('UPDATE signup_otp_requests SET verified_at=now(),consumed_at=now() WHERE id=$1', [row.id]);
        return inserted.rows[0];
      });
      const payload: AuthUser = { sub: user.id, tenantId: user.tenant_id, storeId: user.store_id, role: user.role };
      // Complete account creation without waiting for the external email provider.
      // Email verification continues independently after the account is ready.
      if (row.email) {
        void this.emailVerification.send(user.id, row.email, row.full_name)
          .catch(error => console.error('[SWASS] Welcome email delivery failed:', error instanceof Error ? error.message : error));
      }
      return {
        accessToken: await this.jwt.signAsync(payload, { expiresIn: '30d' }),
        trialDays: 7, phoneVerified: true,
        emailVerificationSent: false, emailVerificationRequired: !!row.email,
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

  @Post('login')
  async login(@Body() body: { phone?: string; password?: string }) {
    const { password } = body ?? {};
    if (!body?.phone || !password) throw new UnauthorizedException();
    const phone = this.normalizePhone(body.phone);

    const localPhone = '0' + phone.slice(3);
    const phoneVariants = [phone, localPhone];
    const { rows } = await this.db.pool.query(
      `SELECT u.id, u.tenant_id, u.store_id, u.role, u.password_hash, u.is_active, t.status AS tenant_status
         FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
        WHERE u.phone = ANY($1::text[])
           OR regexp_replace(u.phone, '[^0-9]', '', 'g') = ANY($1::text[])
        ORDER BY CASE WHEN u.phone = $2 THEN 0 ELSE 1 END
        LIMIT 1`,
      [phoneVariants, phone],
    );
    const u = rows[0];
    // Same error for unknown phone, wrong password or disabled account.
    let passwordOk = false;
    if (u?.password_hash) {
      try { passwordOk = await argon2.verify(u.password_hash, password); } catch { passwordOk = false; }
    }
    const tenantIsUsable = !u?.tenant_id || u.tenant_status === 'active';
    const ok = u && u.is_active && tenantIsUsable && passwordOk;
    if (!ok) throw new UnauthorizedException('Invalid phone or password');

    const payload: AuthUser = { sub: u.id, tenantId: u.tenant_id, storeId: u.store_id, role: u.role };
    return { accessToken: await this.jwt.signAsync(payload, { expiresIn: '30d' }) };
  }
}
