import {
  BadRequestException, Body, Controller, Delete, Get, Param, Post, Req, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { randomUUID } from 'node:crypto';
import { AuthGuard, AuthUser } from '../auth/auth';
import { DbService } from '../db/db.service';

@Controller('api/v1/passkeys')
export class PasskeysController {
  constructor(private db: DbService, private jwt: JwtService) {}

  private rpId(): string {
    const configured = String(process.env.RP_ID || '').trim();
    if (configured) return configured;
    const origin = String(process.env.ORIGIN || 'https://swass-web.onrender.com').split(',')[0].trim();
    return new URL(origin).hostname;
  }

  private expectedOrigins(): string[] {
    const configured = [process.env.ORIGIN || '', process.env.CORS_ORIGINS || '']
      .join(',').split(',').map(value => value.trim()).filter(Boolean);
    return [...new Set([...configured, 'https://swass-web.onrender.com'])];
  }

  private assertOrigin(req: any): void {
    const origin = String(req.headers.origin || '');
    if (!origin || !this.expectedOrigins().includes(origin)) {
      throw new UnauthorizedException('Passkey requests must come from an approved AURORA website.');
    }
  }

  private async takeChallenge(key: string): Promise<string> {
    const result = await this.db.pool.query(
      'DELETE FROM webauthn_challenges WHERE key=$1 AND expires_at>now() RETURNING challenge', [key],
    );
    if (!result.rowCount) throw new BadRequestException('This passkey request expired. Please try again.');
    return result.rows[0].challenge;
  }

  @Post('register/options')
  @UseGuards(AuthGuard)
  async registrationOptions(@Req() req: any) {
    this.assertOrigin(req);
    const user = req.user as AuthUser;
    const isCustomer = user.role === 'customer';
    const account = isCustomer
      ? await this.db.pool.query('SELECT id,full_name,phone FROM customer_accounts WHERE id=$1 AND is_active=true', [user.sub])
      : await this.db.pool.query('SELECT id,full_name,phone FROM users WHERE id=$1 AND is_active=true', [user.sub]);
    if (!account.rowCount) throw new UnauthorizedException('Your account is not active.');
    const existing = await this.db.pool.query(
      isCustomer ? 'SELECT id,transports FROM passkeys WHERE customer_id=$1' : 'SELECT id,transports FROM passkeys WHERE user_id=$1',
      [user.sub],
    );
    const row = account.rows[0];
    const options = await generateRegistrationOptions({
      rpName: 'AURORA E-RECEIPT',
      rpID: this.rpId(),
      userID: new TextEncoder().encode(String(user.sub)),
      userName: String(row.phone || user.sub),
      userDisplayName: String(row.full_name || row.phone || 'AURORA account'),
      attestationType: 'none',
      excludeCredentials: existing.rows.map((item: any) => ({ id: item.id, transports: item.transports || undefined })),
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        userVerification: 'required',
      },
    });
    await this.db.pool.query(
      "INSERT INTO webauthn_challenges(key,challenge,expires_at) VALUES($1,$2,now()+interval '5 minutes') ON CONFLICT(key) DO UPDATE SET challenge=EXCLUDED.challenge,expires_at=EXCLUDED.expires_at",
      ['reg:' + user.sub, options.challenge],
    );
    return options;
  }

  @Post('register/verify')
  @UseGuards(AuthGuard)
  async verifyRegistration(@Req() req: any, @Body() body: { credential?: any; deviceName?: string }) {
    this.assertOrigin(req);
    const user = req.user as AuthUser;
    if (!body?.credential) throw new BadRequestException('Passkey response is missing.');
    const expectedChallenge = await this.takeChallenge('reg:' + user.sub);
    const verification = await verifyRegistrationResponse({
      response: body.credential,
      expectedChallenge,
      expectedOrigin: this.expectedOrigins(),
      expectedRPID: this.rpId(),
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw new BadRequestException('Your phone could not verify this passkey.');
    }
    const info: any = verification.registrationInfo;
    const credential = info.credential || {
      id: info.credentialID ? Buffer.from(info.credentialID).toString('base64url') : body.credential.id,
      publicKey: info.credentialPublicKey,
      counter: info.counter,
      transports: body.credential.response?.transports || [],
    };
    const isCustomer = user.role === 'customer';
    await this.db.pool.query(
      `INSERT INTO passkeys(id,user_id,customer_id,public_key,counter,transports,device_name)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(id) DO NOTHING`,
      [
        credential.id, isCustomer ? null : user.sub, isCustomer ? user.sub : null,
        Buffer.from(credential.publicKey), credential.counter || 0,
        credential.transports || null, String(body.deviceName || 'This device').slice(0,60),
      ],
    );
    await this.db.recordSecurityEvent({
      eventType: 'passkey_registered', outcome: 'success', actorUserId: isCustomer ? null : user.sub,
      sourceIp: req.ip, userAgent: req.headers?.['user-agent'], metadata: { role: user.role, deviceName: String(body.deviceName || 'This device').slice(0,60) },
    });
    return { ok: true };
  }

  @Post('login/options')
  async authenticationOptions(@Req() req: any) {
    this.assertOrigin(req);
    const options = await generateAuthenticationOptions({
      rpID: this.rpId(),
      userVerification: 'required',
      // An empty allowCredentials list enables discoverable passkey sign-in.
    });
    const flowId = randomUUID();
    await this.db.pool.query(
      "INSERT INTO webauthn_challenges(key,challenge,expires_at) VALUES($1,$2,now()+interval '5 minutes')",
      ['auth:' + flowId, options.challenge],
    );
    return { options, flowId };
  }

  @Post('login/verify')
  async verifyAuthentication(@Req() req: any, @Body() body: { flowId?: string; credential?: any }) {
    this.assertOrigin(req);
    const flowId = String(body?.flowId || '');
    const response = body?.credential;
    if (!/^[0-9a-f-]{36}$/i.test(flowId) || !response?.id) throw new BadRequestException('Invalid passkey sign-in request.');
    const expectedChallenge = await this.takeChallenge('auth:' + flowId);
    const found = await this.db.pool.query('SELECT * FROM passkeys WHERE id=$1', [String(response.id)]);
    const passkey = found.rows[0];
    if (!passkey) throw new UnauthorizedException('This passkey is not registered with AURORA. Use your password instead.');
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: this.expectedOrigins(),
      expectedRPID: this.rpId(),
      credential: {
        id: passkey.id,
        publicKey: new Uint8Array(passkey.public_key),
        counter: Number(passkey.counter),
        transports: passkey.transports || undefined,
      },
      requireUserVerification: true,
    });
    if (!verification.verified) throw new UnauthorizedException('Passkey verification failed.');
    await this.db.pool.query(
      'UPDATE passkeys SET counter=$1,last_used_at=now() WHERE id=$2',
      [verification.authenticationInfo.newCounter, passkey.id],
    );

    let user: any;
    let payload: any;
    if (passkey.customer_id) {
      const result = await this.db.pool.query(
        'SELECT id,full_name,phone,email,is_active FROM customer_accounts WHERE id=$1', [passkey.customer_id],
      );
      user = result.rows[0];
      if (!user?.is_active) throw new UnauthorizedException('This account is not active.');
      payload = { sub: user.id, tenantId: null, storeId: null, role: 'customer', fullName: user.full_name };
    } else {
      const result = await this.db.pool.query(
        'SELECT id,tenant_id,store_id,role,full_name,phone,is_active,must_change_password FROM users WHERE id=$1', [passkey.user_id],
      );
      user = result.rows[0];
      if (!user?.is_active) throw new UnauthorizedException('This account is not active.');
      payload = { sub: user.id, tenantId: user.tenant_id, storeId: user.store_id, role: user.role, fullName: user.full_name, mustChangePassword: user.must_change_password || false };
      if (user.role === 'super_admin') {
        const admin = await this.db.pool.query(
          `SELECT r.admin_email,r.person_id FROM aurora_admin_identity_records r
            WHERE r.user_id=$1 AND r.admin_email_verified_at IS NOT NULL LIMIT 1`, [user.id],
        );
        if (!admin.rowCount) throw new UnauthorizedException('Administrator access is not active.');
        payload.adminEmail = admin.rows[0].admin_email;
        payload.adminPersonId = admin.rows[0].person_id;
      }
    }
    const accessToken = await this.jwt.signAsync(payload, { expiresIn: user.role === 'super_admin' ? '8h' : '30d' });
    await this.db.recordSecurityEvent({
      eventType: 'passkey_login_success', outcome: 'success', actorUserId: passkey.user_id || null,
      sourceIp: req.ip, userAgent: req.headers?.['user-agent'], metadata: { role: payload.role },
    });
    return {
      accessToken,
      user: { fullName: user.full_name, phone: user.phone, email: user.email, role: payload.role },
      role: payload.role,
      mustChangePassword: payload.must_change_password || false,
      redirect: payload.role === 'super_admin' ? '/admin.html' : '/',
    };
  }

  @Get('list')
  @UseGuards(AuthGuard)
  async list(@Req() req: any) {
    const user = req.user as AuthUser;
    const column = user.role === 'customer' ? 'customer_id' : 'user_id';
    const result = await this.db.pool.query(
      `SELECT id,device_name,created_at,last_used_at FROM passkeys WHERE ${column}=$1 ORDER BY created_at DESC`,
      [user.sub],
    );
    return { items: result.rows };
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  async remove(@Req() req: any, @Param('id') id: string) {
    const user = req.user as AuthUser;
    const column = user.role === 'customer' ? 'customer_id' : 'user_id';
    const result = await this.db.pool.query(
      `DELETE FROM passkeys WHERE id=$1 AND ${column}=$2 RETURNING id`, [id, user.sub],
    );
    if (!result.rowCount) throw new BadRequestException('That passkey was not found on your account.');
    await this.db.recordSecurityEvent({ eventType: 'passkey_removed', outcome: 'success', actorUserId: user.role === 'customer' ? null : user.sub, sourceIp: req.ip, userAgent: req.headers?.['user-agent'] });
    return { ok: true };
  }
}
