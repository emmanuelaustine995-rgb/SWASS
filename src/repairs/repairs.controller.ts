import { BadRequestException, Controller, Get, Post, Patch, Param, Body, Req, UseGuards, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';

@Controller('api/v1/repairs')
@UseGuards(AuthGuard, RolesGuard)
@Roles('owner', 'manager', 'freelancer')
export class RepairsController {
  constructor(private db: DbService) {}

  private identityKey(): Buffer {
    const secret = process.env.SWASS_ID_SECRET;
    if (!secret) throw new ServiceUnavailableException('Secure identity storage is not configured.');
    return createHash('sha256').update('aurora-repair-customer-id:' + secret).digest();
  }

  private encryptCustomerId(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.identityKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
  }

  private decryptCustomerId(value: string): string {
    const [version, iv, tag, encrypted] = String(value || '').split('.');
    if (version !== 'v1' || !iv || !tag || !encrypted) return 'Unavailable';
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.identityKey(), Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
    } catch { return 'Unavailable'; }
  }

  private requireShop(req: any) {
    if (!req.user?.tenantId || !req.user?.storeId) throw new BadRequestException('A registered shop is required.');
    return req.user;
  }

  @Get()
  async list(@Req() req: any) {
    const user = this.requireShop(req);
    await this.db.ensureRepairSchema();
    const result = await this.db.pool.query(
      `SELECT id, item_name AS "itemName", item_identifier AS "itemIdentifier",
              customer_name AS "customerName", customer_id AS "customerId",
              item_condition AS condition, problem, detected,
              received_date AS "receivedDate", expected_pick_date AS "expectedPickDate",
              status, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM shop_repair_jobs
        WHERE tenant_id=$1 AND store_id=$2
        ORDER BY CASE WHEN status IN ('collected','cancelled') THEN 1 ELSE 0 END,
                 expected_pick_date ASC, created_at DESC
        LIMIT 300`,
      [user.tenantId, user.storeId],
    );
    return { repairs: result.rows.map(row => ({ ...row, customerId: this.decryptCustomerId(row.customerId) })) };
  }


  @Patch(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const user = this.requireShop(req);
    await this.db.ensureRepairSchema();
    if (!/^\\d{1,18}$/.test(String(id || ''))) throw new BadRequestException('A valid repair record is required.');
    const allowed = ['received','diagnosing','in_repair','ready','collected','cancelled'];
    const status = String(body?.status || '').trim();
    const detected = body?.detected === undefined ? undefined : String(body.detected).trim();
    if (status && !allowed.includes(status)) throw new BadRequestException('Choose a valid repair status.');
    if (detected !== undefined && detected.length > 2000) throw new BadRequestException('Diagnosis is too long.');
    if (!status && detected === undefined) throw new BadRequestException('Provide a status or diagnosis update.');
    const result = await this.db.pool.query(
      `UPDATE shop_repair_jobs
          SET status=COALESCE(NULLIF($1,''),status),
              detected=CASE WHEN $2::boolean THEN $3 ELSE detected END,
              updated_at=now()
        WHERE id=$4 AND tenant_id=$5 AND store_id=$6
        RETURNING id,status,detected`,
      [status,detected !== undefined,detected ?? '',id,user.tenantId,user.storeId],
    );
    if (!result.rowCount) throw new NotFoundException('Repair record not found.');
    return { repair: result.rows[0], message: 'Repair record updated.' };
  }

  @Post()
  async create(@Req() req: any, @Body() body: any) {
    const user = this.requireShop(req);
    await this.db.ensureRepairSchema();
    const clean = (value: unknown, label: string, max: number, required = true) => {
      const result = String(value ?? '').trim();
      if (required && !result) throw new BadRequestException(label + ' is required.');
      if (result.length > max) throw new BadRequestException(label + ' is too long.');
      return result;
    };
    const itemName = clean(body?.itemName, 'Goods / item name', 160);
    const itemIdentifier = clean(body?.itemIdentifier, 'Item ID / serial number', 100, false);
    const customerName = clean(body?.customerName, 'Customer name', 160);
    const customerId = clean(body?.customerId, 'Customer ID number', 50);
    const condition = clean(body?.condition, 'Condition', 1000);
    const problem = clean(body?.problem, 'Problem reported', 2000);
    const detected = clean(body?.detected, 'Detected / diagnosis', 2000, false);
    const receivedDate = clean(body?.receivedDate, 'Date received', 10);
    const expectedPickDate = clean(body?.expectedPickDate, 'Expected pick-up date', 10);
    const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0,10) === value;
    if (!validDate(receivedDate) || !validDate(expectedPickDate)) throw new BadRequestException('Enter valid received and expected pick-up dates.');
    if (expectedPickDate < receivedDate) throw new BadRequestException('Expected pick-up date cannot be earlier than the date received.');
    const result = await this.db.pool.query(
      `INSERT INTO shop_repair_jobs
        (tenant_id,store_id,received_by,item_name,item_identifier,customer_name,customer_id,item_condition,problem,detected,received_date,expected_pick_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12::date)
       RETURNING id, item_name AS "itemName", item_identifier AS "itemIdentifier",
                 customer_name AS "customerName", customer_id AS "customerId",
                 item_condition AS condition, problem, detected,
                 received_date AS "receivedDate", expected_pick_date AS "expectedPickDate", status`,
      [user.tenantId,user.storeId,user.sub,itemName,itemIdentifier,customerName,this.encryptCustomerId(customerId),condition,problem,detected,receivedDate,expectedPickDate],
    );
    return { repair: result.rows[0], message: 'Goods received for repair and saved.' };
  }
}
