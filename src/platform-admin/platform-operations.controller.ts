import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';

const kinds = ['incident', 'maintenance', 'change', 'recovery'] as const;
const severities = ['critical', 'high', 'medium', 'low', 'info'] as const;
const statuses = ['open', 'investigating', 'mitigated', 'resolved', 'closed'] as const;

@Controller('api/v1/platform-admin/operations')
@UseGuards(AuthGuard, RolesGuard)
@Roles('super_admin')
export class PlatformOperationsController {
  private schemaPromise: Promise<void> | null = null;
  constructor(private readonly db: DbService) {}

  private async ensureSchema(): Promise<void> {
    if (!this.schemaPromise) {
      this.schemaPromise = this.db.pool.query(`
        CREATE TABLE IF NOT EXISTS aurora_operations_work_items (
          id BIGSERIAL PRIMARY KEY,
          kind VARCHAR(20) NOT NULL CHECK (kind IN ('incident','maintenance','change','recovery')),
          title VARCHAR(160) NOT NULL,
          description VARCHAR(2000) NOT NULL DEFAULT '',
          severity VARCHAR(16) NOT NULL DEFAULT 'medium' CHECK (severity IN ('critical','high','medium','low','info')),
          status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','mitigated','resolved','closed')),
          owner_label VARCHAR(120) NOT NULL DEFAULT '',
          due_at TIMESTAMPTZ NULL,
          resolution TEXT NOT NULL DEFAULT '',
          created_by UUID NULL,
          updated_by UUID NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS aurora_operations_work_items_status_idx
          ON aurora_operations_work_items(status, severity, updated_at DESC);
        CREATE INDEX IF NOT EXISTS aurora_operations_work_items_kind_idx
          ON aurora_operations_work_items(kind, created_at DESC);
      `).then(() => undefined).catch(error => { this.schemaPromise = null; throw error; });
    }
    await this.schemaPromise;
  }

  @Get('work-items')
  async listWorkItems(@Query('kind') kind = '', @Query('status') status = '', @Query('limit') limit = '100') {
    await this.ensureSchema();
    const take = Math.min(200, Math.max(1, Number.parseInt(String(limit), 10) || 100));
    const safeKind = (kinds as readonly string[]).includes(kind) ? kind : '';
    const safeStatus = (statuses as readonly string[]).includes(status) ? status : '';
    const result = await this.db.pool.query(`
      SELECT id,kind,title,description,severity,status,owner_label AS "ownerLabel",
             due_at AS "dueAt",resolution,created_by AS "createdBy",updated_by AS "updatedBy",
             created_at AS "createdAt",updated_at AS "updatedAt"
        FROM aurora_operations_work_items
       WHERE ($1='' OR kind=$1) AND ($2='' OR status=$2)
       ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                updated_at DESC
       LIMIT $3
    `, [safeKind, safeStatus, take]);
    return { items: result.rows };
  }

  @Post('work-items')
  async createWorkItem(@Body() body: any, @Req() req: any) {
    const kind = String(body?.kind || '');
    const title = String(body?.title || '').trim();
    const description = String(body?.description || '').trim();
    const severity = String(body?.severity || 'medium');
    const ownerLabel = String(body?.ownerLabel || '').trim();
    const dueAt = body?.dueAt ? new Date(body.dueAt) : null;
    if (!(kinds as readonly string[]).includes(kind)) throw new BadRequestException('Choose a valid operations record type.');
    if (!title || title.length > 160) throw new BadRequestException('Title is required and must be 160 characters or fewer.');
    if (description.length > 2000 || ownerLabel.length > 120) throw new BadRequestException('Description or assigned owner is too long.');
    if (!(severities as readonly string[]).includes(severity)) throw new BadRequestException('Choose a valid severity.');
    if (dueAt && Number.isNaN(dueAt.getTime())) throw new BadRequestException('Enter a valid due date.');
    await this.ensureSchema();
    const result = await this.db.pool.query(`
      INSERT INTO aurora_operations_work_items
        (kind,title,description,severity,owner_label,due_at,created_by,updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
      RETURNING id,kind,title,description,severity,status,owner_label AS "ownerLabel",
                due_at AS "dueAt",created_at AS "createdAt",updated_at AS "updatedAt"
    `, [kind,title,description,severity,ownerLabel,dueAt,req.user?.sub || null]);
    await this.db.recordSecurityEvent({
      eventType: kind === 'incident' ? 'incident_created' : 'operations_work_item_created',
      severity: severity === 'critical' ? 'critical' : severity === 'high' ? 'high' : 'medium',
      outcome: 'completed', actorUserId: req.user?.sub, sourceIp: req.ip,
      userAgent: req.headers?.['user-agent'], metadata: { workItemId: result.rows[0].id, kind, severity },
    });
    return { item: result.rows[0] };
  }

  @Patch('work-items/:id')
  async updateWorkItem(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    if (!/^\\d+$/.test(id)) throw new BadRequestException('Invalid operations record ID.');
    const status = body?.status === undefined ? null : String(body.status);
    const resolution = body?.resolution === undefined ? null : String(body.resolution).trim();
    const ownerLabel = body?.ownerLabel === undefined ? null : String(body.ownerLabel).trim();
    if (status !== null && !(statuses as readonly string[]).includes(status)) throw new BadRequestException('Choose a valid status.');
    if (resolution !== null && resolution.length > 4000) throw new BadRequestException('Resolution must be 4,000 characters or fewer.');
    if (ownerLabel !== null && ownerLabel.length > 120) throw new BadRequestException('Assigned owner must be 120 characters or fewer.');
    if (status === null && resolution === null && ownerLabel === null) throw new BadRequestException('Provide a status, resolution or assigned owner update.');
    await this.ensureSchema();
    const result = await this.db.pool.query(`
      UPDATE aurora_operations_work_items
         SET status=COALESCE($2,status), resolution=COALESCE($3,resolution),
             owner_label=COALESCE($4,owner_label), updated_by=$5, updated_at=now()
       WHERE id=$1
       RETURNING id,kind,title,description,severity,status,owner_label AS "ownerLabel",
                 due_at AS "dueAt",resolution,created_at AS "createdAt",updated_at AS "updatedAt"
    `, [id,status,resolution,ownerLabel,req.user?.sub || null]);
    if (!result.rowCount) throw new BadRequestException('Operations record was not found.');
    await this.db.recordSecurityEvent({
      eventType: 'operations_work_item_updated', severity: 'medium', outcome: 'completed',
      actorUserId: req.user?.sub, sourceIp: req.ip, userAgent: req.headers?.['user-agent'],
      metadata: { workItemId: id, status: status || undefined },
    });
    return { item: result.rows[0] };
  }
}
