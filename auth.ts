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

  @Post('login')
  async login(@Body() body: { phone?: string; password?: string }) {
    const { phone, password } = body ?? {};
    if (!phone || !password) throw new UnauthorizedException();

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
