import { BadRequestException, Controller, Delete, Get, Post, Req, UseGuards } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';

@Controller('api/v1/staff')
@UseGuards(AuthGuard, RolesGuard)
export class StaffController {
  constructor(private db: DbService) {}

  private hash(code: string) {
    const secret = process.env.SWASS_ID_SECRET;
    if (!secret) throw new Error('SWASS_ID_SECRET is required');
    return createHmac('sha256', secret).update('staff-invite:' + code).digest('hex');
  }

  @Post('invitations')
  @Roles('owner')
  async createInvitation(@Req() req: any) {
    const user = req.user;
    if (!user?.tenantId || !user?.storeId) throw new BadRequestException('Business owner account required');
    const code = String(10000000 + (randomBytes(4).readUInt32BE(0) % 90000000));
    const expiresAt = new Date(Date.now() + 7 * 86400000);
    const result = await this.db.pool.query(
      `INSERT INTO staff_invitations(tenant_id,store_id,code_hash,created_by,expires_at)
       VALUES($1,$2,$3,$4,$5) RETURNING id,expires_at`,
      [user.tenantId,user.storeId,this.hash(code),user.sub,expiresAt],
    );
    return { invitation: { id: result.rows[0].id, code, expiresAt: result.rows[0].expires_at, role: 'cashier' } };
  }

  @Get('invitations')
  @Roles('owner')
  async listInvitations(@Req() req: any) {
    const result = await this.db.pool.query(
      `SELECT i.id,i.expires_at AS "expiresAt",i.revoked_at AS "revokedAt",i.accepted_by IS NOT NULL AS accepted,
              u.full_name AS "acceptedBy"
         FROM staff_invitations i LEFT JOIN users u ON u.id=i.accepted_by
        WHERE i.tenant_id=$1 AND i.store_id=$2 ORDER BY i.created_at DESC LIMIT 50`,
      [req.user.tenantId,req.user.storeId],
    );
    return { invitations: result.rows };
  }

  @Delete('invitations/:id')
  @Roles('owner')
  async revokeInvitation(@Req() req: any) {
    const id = String(req.params?.id || '');
    const result = await this.db.pool.query(
      `UPDATE staff_invitations SET revoked_at=now()
        WHERE id=$1 AND tenant_id=$2 AND store_id=$3 AND accepted_by IS NULL AND revoked_at IS NULL
        RETURNING id`,
      [id,req.user.tenantId,req.user.storeId],
    );
    if (!result.rowCount) throw new BadRequestException('Invitation not found or already used');
    return { revoked: true };
  }
}
