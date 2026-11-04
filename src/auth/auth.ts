import {
  CanActivate, Controller, ExecutionContext, ForbiddenException, Injectable,
  Post, Body, SetMetadata, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { DbService } from '../db/db.service';

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
  constructor(private db: DbService, private jwt: JwtService) {}

  private normalizePhone(value: string): string {
    const digits = value.replace(/\D/g, '');
    if (digits.startsWith('254') && digits.length === 12) return digits;
    if (digits.startsWith('0') && digits.length === 10) return '254' + digits.slice(1);
    if (digits.length === 9) return '254' + digits;
    throw new UnauthorizedException('Enter a valid Kenyan phone number');
  }

  @Post('register')
  async register(@Body() body: { businessName?: string; storeName?: string; fullName?: string; phone?: string; email?: string; password?: string }) {
    const businessName = body?.businessName?.trim();
    const storeName = (body?.storeName || body?.businessName)?.trim();
    const fullName = body?.fullName?.trim();
    const email = body?.email?.trim().toLowerCase() || null;
    const password = body?.password || '';
    if (!businessName || businessName.length > 120 || !storeName || storeName.length > 120 || !fullName || fullName.length > 120) {
      throw new UnauthorizedException('Enter your business name, store name and full name (maximum 120 characters each)');
    }
    if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) throw new UnauthorizedException('Enter a valid email address');
    if (password.length < 10 || password.length > 128) throw new UnauthorizedException('Password must be at least 10 characters');
    const phone = this.normalizePhone(body.phone || '');
    const passwordHash = await argon2.hash(password);
    try {
      const result = await this.db.tx(async c => {
        const tenant = await c.query(
          'INSERT INTO tenants (name, phone, email) VALUES ($1,$2,$3) RETURNING id',
          [businessName, phone, email],
        );
        const tenantId = tenant.rows[0].id;
        const store = await c.query(
          'INSERT INTO stores (tenant_id,name) VALUES ($1,$2) RETURNING id',
          [tenantId, storeName],
        );
        const user = await c.query(
          `INSERT INTO users (tenant_id,store_id,full_name,phone,email,password_hash,role)
           VALUES ($1,$2,$3,$4,$5,$6,'owner') RETURNING id,tenant_id,store_id,role`,
          [tenantId, store.rows[0].id, fullName, phone, email, passwordHash],
        );
        await c.query('INSERT INTO wallets (tenant_id) VALUES ($1)', [tenantId]);
        await c.query(
          `INSERT INTO subscriptions (tenant_id,plan,price_kes,starts_at,ends_at,status,auto_renew)
           VALUES ($1,'monthly',100,now(),now()+interval '7 days','active',false)`,
          [tenantId],
        );
        return user.rows[0];
      });
      const payload: AuthUser = { sub: result.id, tenantId: result.tenant_id, storeId: result.store_id, role: result.role };
      return { accessToken: await this.jwt.signAsync(payload, { expiresIn: '12h' }), trialDays: 7 };
    } catch (err: any) {
      if (err?.code === '23505') throw new UnauthorizedException('This phone number is already registered. Sign in or use another number.');
      throw err;
    }
  }

  @Post('login')
  async login(@Body() body: { phone?: string; password?: string }) {
    const { password } = body ?? {};
    if (!body?.phone || !password) throw new UnauthorizedException();
    const phone = this.normalizePhone(body.phone);

    const { rows } = await this.db.pool.query(
      `SELECT u.id, u.tenant_id, u.store_id, u.role, u.password_hash, u.is_active, t.status AS tenant_status
         FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
        WHERE u.phone = $1`,
      [phone],
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
    return { accessToken: await this.jwt.signAsync(payload, { expiresIn: '12h' }) };
  }
}
