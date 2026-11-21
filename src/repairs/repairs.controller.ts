import { BadRequestException, Controller, Get, Post, Patch, Param, Body, Req, UseGuards, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';
import { WhatsAppReceiptService } from '../notifications/whatsapp-receipt.service';

@Controller('api/v1/repairs')
@UseGuards(AuthGuard, RolesGuard)
@Roles('owner', 'manager', 'cashier', 'freelancer', 'vendor')
export class RepairsController {
  constructor(private db: DbService, private whatsapp: WhatsAppReceiptService) {}

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

  private normalizeCustomerPhone(value: string): string {
    const digits = String(value || '').replace(/\D/g, '');
    const national = digits.startsWith('254') ? digits.slice(3) : digits.startsWith('0') ? digits.slice(1) : digits;
    if (!/^[17]\d{8}$/.test(national)) throw new BadRequestException('Enter a valid Kenyan customer phone number.');
    return '254' + national;
  }

  private requireShop(req: any) {
    if (!req.user?.tenantId || !req.user?.storeId) throw new BadRequestException('A registered shop is required.');
    return req.user;
  }

  private async makePdf(repair: any, shop: any): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: [420, 595], margin: 24, info: { Title: 'AURORA Repair Intake ' + repair.reference, Author: shop.name || 'AURORA E-RECEIPT' } });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const ink = '#203247', muted = '#64748b', blue = '#145b91', line = '#d8e2ec';
      doc.fillColor(blue).font('Helvetica-Bold').fontSize(15).text(shop.name || 'AURORA E-RECEIPT', { align: 'center' });
      doc.fillColor(muted).font('Helvetica').fontSize(8).text([shop.store_name, shop.location, shop.phone].filter(Boolean).join(' · '), { align: 'center' });
      doc.moveDown(0.6).moveTo(24, doc.y).lineTo(396, doc.y).strokeColor(line).stroke();
      doc.moveDown(0.7).fillColor(blue).font('Helvetica-Bold').fontSize(12).text('REPAIR INTAKE RECEIPT', { align: 'center' });
      doc.moveDown(0.4).fillColor(ink).fontSize(10).text('Reference: ' + repair.reference);
      doc.font('Helvetica').fontSize(8).fillColor(muted).text('Received: ' + repair.receivedDate + '     Expected collection: ' + repair.expectedPickDate);
      const field = (label: string, value: any) => {
        doc.moveDown(0.65).fillColor(muted).font('Helvetica-Bold').fontSize(7).text(label.toUpperCase());
        doc.moveDown(0.15).fillColor(ink).font('Helvetica').fontSize(9).text(String(value || '—'), { width: 370 });
      };
      field('Customer', repair.customerName);
      field('Customer phone', repair.customerPhone);
      field('Item / model', repair.itemName);
      field('Serial / IMEI', repair.itemIdentifier);
      field('Condition received', repair.condition);
      field('Customer reported problem', repair.problem);
      field('Accessories received', repair.accessories);
      field('Logged by', repair.receivedByName);
      doc.moveDown(1).moveTo(24, doc.y).lineTo(396, doc.y).strokeColor(line).stroke();
      doc.moveDown(0.7).fillColor(muted).font('Helvetica').fontSize(7).text('This confirms that the item was received for inspection/repair. It is not a payment receipt. Keep this reference for collection and tracking.', { align: 'center', width: 370 });
      doc.moveDown(0.6).fillColor(blue).font('Helvetica-Bold').fontSize(8).text('AURORA E-RECEIPT · BY E-TECH', { align: 'center' });
      doc.end();
    });
  }

  private async deliverEmail(to: string, subject: string, html: string, pdf: Buffer, filename: string) {
    const apiKey = process.env.BREVO_API_KEY?.trim(), from = process.env.BREVO_FROM_EMAIL?.trim();
    if (!to) return { sent: false, reason: 'Email address is not registered' };
    if (!apiKey || !from) return { sent: false, reason: 'Brevo email is not configured' };
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { email: from, name: 'AURORA E-RECEIPT' }, to: [{ email: to }], subject, htmlContent: html, attachment: [{ name: filename, content: pdf.toString('base64') }] }),
    });
    if (!response.ok) throw new Error('Email provider rejected the repair notification (' + response.status + ').');
    return { sent: true, provider: 'brevo' };
  }

  private async deliverSms(to: string, text: string) {
    const token = process.env.TALKSASA_API_TOKEN || process.env.TALKSASA_API_KEY;
    if (!to) return { sent: false, reason: 'Owner phone number is not registered' };
    if (!token) return { sent: false, reason: 'SMS provider is not configured' };
    const digits = to.replace(/\D/g, '');
    const phone = digits.startsWith('254') ? digits : digits.startsWith('0') ? '254' + digits.slice(1) : '254' + digits;
    if (!/^254[17]\d{8}$/.test(phone)) return { sent: false, reason: 'Owner phone number is invalid' };
    const configured = (process.env.TALKSASA_API_URL || 'https://bulksms.talksasa.com/api/v3').replace(/\/+$/, '');
    const endpoint = /\/sms\/send$/i.test(configured) ? configured : configured + '/sms/send';
    const response = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ recipient: '+' + phone, sender_id: process.env.TALKSASA_SENDER_ID || 'TALK-SASA', type: 'plain', message: text }) });
    const raw = await response.text(); let data: any = {}; try { data = raw ? JSON.parse(raw) : {}; } catch {}
    const status = String(data?.status ?? data?.data?.status ?? '').toLowerCase();
    if (!response.ok || !(status === 'success' || status === 'accepted' || status === 'queued' || data?.success === true || data?.status === true)) throw new Error('SMS provider did not accept the notification.');
    return { sent: true, provider: 'talksasa' };
  }

  private async safeDelivery(fn: () => Promise<any>) {
    try { return await fn(); } catch (error) { return { sent: false, reason: error instanceof Error ? error.message : 'Delivery failed' }; }
  }

  private async notifyOwner(input: { owner: any; shop: any; repair: any; pdf: Buffer; stage: 'received' | 'ready' }) {
    const title = input.stage === 'received' ? 'New repair received' : 'Repair ready for collection';
    const text = 'AURORA ' + title + ': ' + input.repair.reference + ' · ' + input.repair.itemName + ' · Customer ' + input.repair.customerName + '. Logged by ' + input.repair.receivedByName + '.';
    const html = '<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#203247"><h2>' + title + '</h2><p><b>Repair reference:</b> ' + input.repair.reference + '</p><p><b>Customer:</b> ' + input.repair.customerName + ' · ' + input.repair.customerPhone + '</p><p><b>Item:</b> ' + input.repair.itemName + '</p><p><b>Reported problem:</b> ' + input.repair.problem + '</p><p><b>Status:</b> ' + (input.stage === 'ready' ? 'Ready for collection' : 'Received') + '</p><p><b>Recorded by:</b> ' + input.repair.receivedByName + '</p><p>The repair intake/update PDF is attached.</p></div>';
    const [email, whatsapp, sms] = await Promise.all([
      this.safeDelivery(() => this.deliverEmail(input.owner.email, 'AURORA · ' + title + ' · ' + input.repair.reference, html, input.pdf, input.repair.reference + '.pdf')),
      this.safeDelivery(() => this.whatsapp.sendPdf({ to: input.owner.phone, receiptNo: input.repair.reference, businessName: input.shop.name || 'AURORA', pdf: input.pdf })),
      input.stage === 'received' ? this.safeDelivery(() => this.deliverSms(input.owner.phone, text)) : Promise.resolve({ sent: false, reason: 'SMS update is not enabled for this stage' }),
    ]);
    return { email, whatsapp, sms };
  }

  @Get('mine')
  @Roles('customer')
  async mine(@Req() req: any) {
    const account = await this.db.pool.query('SELECT phone FROM customer_accounts WHERE id=$1 AND is_active=true LIMIT 1', [req.user.sub]);
    if (!account.rows[0]) throw new NotFoundException('Customer account not found.');
    const digits = String(account.rows[0].phone || '').replace(/\D/g, '');
    const result = await this.db.pool.query(
      `SELECT reference, item_name AS "itemName", item_identifier AS "itemIdentifier",
              problem, detected, received_date AS "receivedDate", expected_pick_date AS "expectedPickDate",
              status, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM shop_repair_jobs
        WHERE regexp_replace(customer_phone, '\\D', '', 'g')=$1
        ORDER BY created_at DESC LIMIT 100`, [digits],
    );
    return { repairs: result.rows };
  }

  @Get()
  async list(@Req() req: any) {
    const user = this.requireShop(req);
    await this.db.ensureRepairSchema();
    const result = await this.db.pool.query(
      `SELECT id, reference, item_name AS "itemName", item_identifier AS "itemIdentifier",
              customer_name AS "customerName", customer_phone AS "customerPhone",
              customer_email AS "customerEmail", customer_id AS "customerId",
              item_condition AS "condition", problem, detected, accessories,
              received_by_name AS "receivedByName",
              received_date AS "receivedDate", expected_pick_date AS "expectedPickDate",
              status, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM shop_repair_jobs
        WHERE tenant_id=$1 AND store_id=$2
        ORDER BY CASE WHEN status IN ('collected','cancelled') THEN 1 ELSE 0 END,
                 expected_pick_date ASC, created_at DESC LIMIT 300`,
      [user.tenantId, user.storeId],
    );
    return { repairs: result.rows.map(row => ({ ...row, customerId: this.decryptCustomerId(row.customerId) })) };
  }

  @Patch(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const user = this.requireShop(req);
    await this.db.ensureRepairSchema();
    if (!/^\d{1,18}$/.test(String(id || ''))) throw new BadRequestException('A valid repair record is required.');
    const allowed = ['received','diagnosing','in_repair','ready','collected','cancelled'];
    const status = String(body?.status || '').trim();
    const detected = body?.detected === undefined ? undefined : String(body.detected).trim();
    if (status && !allowed.includes(status)) throw new BadRequestException('Choose a valid repair status.');
    if (detected !== undefined && detected.length > 2000) throw new BadRequestException('Diagnosis is too long.');
    if (!status && detected === undefined) throw new BadRequestException('Provide a status or diagnosis update.');
    const result = await this.db.pool.query(
      `UPDATE shop_repair_jobs SET status=COALESCE(NULLIF($1,''),status),
              detected=CASE WHEN $2::boolean THEN $3 ELSE detected END, updated_at=now()
        WHERE id=$4 AND tenant_id=$5 AND store_id=$6
        RETURNING id,reference,item_name AS "itemName",customer_name AS "customerName",
                  customer_phone AS "customerPhone",customer_email AS "customerEmail",
                  problem,detected,status,received_date AS "receivedDate",
                  expected_pick_date AS "expectedPickDate",received_by_name AS "receivedByName"`,
      [status, detected !== undefined, detected ?? '', id, user.tenantId, user.storeId],
    );
    const repair = result.rows[0];
    if (!repair) throw new NotFoundException('Repair record not found.');
    if (status) {
      await this.db.pool.query('INSERT INTO shop_repair_events(repair_id,tenant_id,store_id,actor_user_id,actor_name,event_type,details) VALUES($1,$2,$3,$4,$5,$6,$7)', [id,user.tenantId,user.storeId,user.sub,user.fullName||'Shop team',status,detected||'']);
    }
    let ownerDelivery: any = null;
    if (status === 'ready') {
      const shopResult = await this.db.pool.query('SELECT t.name,t.phone,t.email,s.name AS store_name,s.location FROM tenants t JOIN stores s ON s.tenant_id=t.id AND s.id=$2 WHERE t.id=$1', [user.tenantId,user.storeId]);
      const ownerResult = await this.db.pool.query("SELECT email,phone,full_name FROM users WHERE tenant_id=$1 AND role='owner' AND is_active=true ORDER BY created_at ASC LIMIT 1", [user.tenantId]);
      const shop = shopResult.rows[0] || {}, owner = ownerResult.rows[0] || {};
      const pdf = await this.makePdf(repair, shop);
      ownerDelivery = await this.notifyOwner({ owner, shop, repair, pdf, stage: 'ready' });
      const customerText = 'AURORA repair update: ' + repair.reference + ' for ' + repair.itemName + ' is ready for collection at ' + (shop.name || 'the shop') + '. Please present your repair reference when collecting.';
      const customerDelivery = {
        email: repair.customerEmail ? await this.safeDelivery(() => this.deliverEmail(repair.customerEmail,'Your item is ready for collection · '+repair.reference,'<p>Hello '+repair.customerName+', your item is ready for collection. Please present repair reference <b>'+repair.reference+'</b> at '+(shop.name||'the shop')+'.</p>',pdf,repair.reference+'-ready.pdf')) : { sent: false, reason: 'Customer email was not provided' },
        whatsapp: await this.safeDelivery(() => this.whatsapp.sendText({ to: repair.customerPhone, text: customerText })),
      };
      await this.db.pool.query('INSERT INTO shop_repair_events(repair_id,tenant_id,store_id,actor_user_id,actor_name,event_type,details) VALUES($1,$2,$3,$4,$5,$6,$7)', [id,user.tenantId,user.storeId,user.sub,user.fullName||'Shop team','ready_notification',JSON.stringify({ownerDelivery,customerDelivery})]);
      return { repair, ownerDelivery, customerDelivery, message: 'Repair marked ready. Owner and customer notification attempts completed.' };
    }
    return { repair, ownerDelivery, message: 'Repair record updated.' };
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
    const customerPhone = this.normalizeCustomerPhone(clean(body?.customerPhone, 'Customer phone number', 30));
    const customerEmail = clean(body?.customerEmail, 'Customer email', 254, false).toLowerCase();
    const condition = clean(body?.condition, 'Condition', 1000);
    const problem = clean(body?.problem, 'Problem reported', 2000);
    const accessories = clean(body?.accessories, 'Accessories received', 500, false);
    const detected = clean(body?.detected, 'Detected / diagnosis', 2000, false);
    const receivedDate = clean(body?.receivedDate, 'Date received', 10);
    const expectedPickDate = clean(body?.expectedPickDate, 'Expected pick-up date', 10);
    const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0,10) === value;
    if (!validDate(receivedDate) || !validDate(expectedPickDate)) throw new BadRequestException('Enter valid received and expected pick-up dates.');
    if (expectedPickDate < receivedDate) throw new BadRequestException('Expected pick-up date cannot be earlier than the date received.');
    if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) throw new BadRequestException('Enter a valid customer email address.');
    const result = await this.db.pool.query(
      `INSERT INTO shop_repair_jobs
        (tenant_id,store_id,received_by,received_by_name,item_name,item_identifier,customer_name,customer_id,customer_phone,customer_email,item_condition,problem,accessories,detected,received_date,expected_pick_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::date,$16::date)
       RETURNING id, item_name AS "itemName", item_identifier AS "itemIdentifier",
                 customer_name AS "customerName", customer_phone AS "customerPhone",
                 customer_email AS "customerEmail", customer_id AS "customerId",
                 item_condition AS condition, problem, accessories, detected,
                 received_by_name AS "receivedByName", received_date AS "receivedDate",
                 expected_pick_date AS "expectedPickDate", status`,
      [user.tenantId,user.storeId,user.sub,user.fullName||'Shop team',itemName,itemIdentifier,customerName,this.encryptCustomerId(customerId),customerPhone,customerEmail,condition,problem,accessories,detected,receivedDate,expectedPickDate],
    );
    const repair = result.rows[0];
    repair.reference = 'AUR-RP-' + String(repair.id).padStart(7,'0');
    await this.db.pool.query('UPDATE shop_repair_jobs SET reference=$1 WHERE id=$2',[repair.reference,repair.id]);
    repair.customerId = this.decryptCustomerId(repair.customerId);
    const shopResult = await this.db.pool.query('SELECT t.name,t.phone,t.email,s.name AS store_name,s.location FROM tenants t JOIN stores s ON s.tenant_id=t.id AND s.id=$2 WHERE t.id=$1',[user.tenantId,user.storeId]);
    const ownerResult = await this.db.pool.query("SELECT email,phone,full_name FROM users WHERE tenant_id=$1 AND role='owner' AND is_active=true ORDER BY created_at ASC LIMIT 1",[user.tenantId]);
    const shop = shopResult.rows[0] || {}, owner = ownerResult.rows[0] || {};
    const pdf = await this.makePdf(repair, shop);
    await this.db.pool.query('INSERT INTO shop_repair_events(repair_id,tenant_id,store_id,actor_user_id,actor_name,event_type,details) VALUES($1,$2,$3,$4,$5,$6,$7)',[repair.id,user.tenantId,user.storeId,user.sub,user.fullName||'Shop team','received','Item received and intake receipt generated.']);
    const ownerDelivery = await this.notifyOwner({ owner, shop, repair, pdf, stage: 'received' });
    const customerDelivery = {
      email: customerEmail ? await this.safeDelivery(() => this.deliverEmail(customerEmail,'Your AURORA repair intake receipt · '+repair.reference,'<p>Hello '+repair.customerName+', your item has been received by '+(shop.name||'the shop')+'. Keep repair reference <b>'+repair.reference+'</b> for tracking and collection.</p>',pdf,repair.reference+'.pdf')) : { sent: false, reason: 'Customer email was not provided' },
      whatsapp: await this.safeDelivery(() => this.whatsapp.sendPdf({ to: customerPhone, receiptNo: repair.reference, businessName: shop.name || 'AURORA', pdf })),
    };
    return { repair, pdfBase64: pdf.toString('base64'), ownerDelivery, customerDelivery, message: 'Repair saved. The intake PDF has been generated and notification attempts recorded.' };
  }
}
