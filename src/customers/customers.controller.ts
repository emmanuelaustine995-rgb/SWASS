import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import PDFDocument = require('pdfkit');
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';
import { hashNationalId, normalisePhone } from '../receipts/receipts.service';
import { EmailVerificationService } from '../notifications/email-verification.service';
import { WhatsAppReceiptService } from '../notifications/whatsapp-receipt.service';

@Controller('api/v1/customers')
@UseGuards(AuthGuard, RolesGuard)
export class CustomersController {
  constructor(private db: DbService, private email: EmailVerificationService, private whatsapp: WhatsAppReceiptService) {}

  @Get('referral-summary')
  @Roles('customer')
  async customerReferralSummary(@Req() req: any) {
    const customerId = req.user?.sub;
    if (!customerId) throw new BadRequestException('Customer account required');
    let account = await this.db.pool.query('SELECT id,full_name,referral_code FROM customer_accounts WHERE id=$1 AND is_active=true',[customerId]);
    if (!account.rowCount) throw new BadRequestException('Customer account not found');
    if (!account.rows[0].referral_code) {
      const code = randomBytes(6).toString('hex').toUpperCase();
      await this.db.pool.query('UPDATE customer_accounts SET referral_code=$1 WHERE id=$2 AND referral_code IS NULL',[code,customerId]);
      account = await this.db.pool.query('SELECT id,full_name,referral_code FROM customer_accounts WHERE id=$1',[customerId]);
    }
    const counts = await this.db.pool.query('SELECT COUNT(*)::int AS total FROM customer_referrals WHERE referrer_customer_id=$1',[customerId]);
    const baseUrl = (process.env.AURORA_WEB_URL || 'https://swass-web.onrender.com').replace(/\/$/,'');
    return {fullName:account.rows[0].full_name,referralCode:account.rows[0].referral_code,referralLink:`${baseUrl}/?customer_ref=${encodeURIComponent(account.rows[0].referral_code)}`,totalReferrals:Number(counts.rows[0]?.total||0)};
  }

  @Post('sales-declarations')
  @Roles('customer')
  async submitCustomerSalesDeclaration(@Req() req: any, @Body() body: any) {
    const customerId = req.user?.sub;
    if (!customerId) throw new BadRequestException('Customer account required.');
    const account = await this.db.pool.query(
      'SELECT id,full_name FROM customer_accounts WHERE id=$1 AND is_active=true LIMIT 1',
      [customerId],
    );
    if (!account.rowCount) throw new BadRequestException('Active customer account not found.');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Declaration details are required.');
    const encoded = JSON.stringify(body);
    if (encoded.length > 480000) throw new BadRequestException('The attached evidence is too large. Please use smaller photos.');
    const required = ['sellerName','nationalId','sellerPhone','sellerEmail','buyerName','buyerNationalId','buyerPhone','buyerEmail','residentialAddress','productName','condition'];
    for (const key of required) {
      if (typeof body[key] !== 'string' || !body[key].trim() || body[key].length > 1000) {
        throw new BadRequestException('Please complete the required declaration details.');
      }
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.sellerEmail) ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.buyerEmail)) {
      throw new BadRequestException('Enter valid seller and buyer email addresses.');
    }
    if (!['with_receipt','without_receipt'].includes(body.saleType)) throw new BadRequestException('Choose the original receipt status.');
    if (!['New','Excellent','Good','Fair','Faulty'].includes(body.condition)) throw new BadRequestException('Choose a valid product condition.');
    if (!Number.isSafeInteger(body.purchasePriceKes) || body.purchasePriceKes < 1) throw new BadRequestException('Enter a valid agreed price.');
    if (body.declarationAccepted !== true) throw new BadRequestException('The seller must accept the ownership declaration.');
    if (typeof body.signatureData !== 'string' || !body.signatureData.startsWith('data:image/')) throw new BadRequestException('The seller signature is required.');
    if (typeof body.idPhotoData !== 'string' || !body.idPhotoData.startsWith('data:image/')) throw new BadRequestException('The seller ID photo is required.');
    if (typeof body.phonePhotoData !== 'string' || !body.phonePhotoData.startsWith('data:image/')) throw new BadRequestException('The product photo is required.');
    if (body.saleType === 'without_receipt' && (body.declarationAccepted !== true || !body.noReceiptReason)) {
      throw new BadRequestException('Explain why the original receipt is unavailable.');
    }
    const declarationRef = 'AUR-C-' + Date.now().toString(36).toUpperCase() + '-' + randomBytes(3).toString('hex').toUpperCase();
    const saved = await this.db.pool.query(
      `INSERT INTO customer_sales_declaration_submissions
        (customer_id, declaration_ref, seller_name, product_name, payload, status)
       VALUES ($1,$2,$3,$4,$5::jsonb,'pending_review')
       RETURNING id, declaration_ref AS "declarationRef", status, created_at AS "createdAt"`,
      [customerId, declarationRef, body.sellerName.trim(), body.productName.trim(), encoded],
    );
    const submission = saved.rows[0];
    const declaration = { ...body, declarationRef, createdAt: submission.createdAt };
    const pdf = await this.buildCustomerSalesDeclarationPdf(declaration);
    const deliverEmail = async (to: string, recipientName: string) => {
      try {
        await this.email.sendCustomerSalesDeclaration({
          to, recipientName, reference: declarationRef,
          productName: String(body.productName), sellerName: String(body.sellerName),
          buyerName: String(body.buyerName), pdf,
        });
        return { sent: true, reason: null as string | null };
      } catch (error) {
        return { sent: false, reason: error instanceof Error ? error.message : 'Email delivery failed' };
      }
    };
    const deliverWhatsApp = async (to: string) => {
      try {
        await this.whatsapp.sendPdf({ to, receiptNo: declarationRef, businessName: 'AURORA E-RECEIPT', pdf });
        return { sent: true, reason: null as string | null };
      } catch (error) {
        return { sent: false, reason: error instanceof Error ? error.message : 'WhatsApp delivery failed' };
      }
    };
    const [sellerEmail, buyerEmail, sellerWhatsApp, buyerWhatsApp] = await Promise.all([
      deliverEmail(String(body.sellerEmail).trim().toLowerCase(), String(body.sellerName)),
      deliverEmail(String(body.buyerEmail).trim().toLowerCase(), String(body.buyerName)),
      deliverWhatsApp(String(body.sellerPhone)),
      deliverWhatsApp(String(body.buyerPhone)),
    ]);
    return {
      submission,
      pdfBase64: pdf.toString('base64'),
      delivery: {
        seller: { email: sellerEmail, whatsapp: sellerWhatsApp },
        buyer: { email: buyerEmail, whatsapp: buyerWhatsApp },
      },
      message: 'The complete Sales Declaration PDF was created and delivery was attempted by email and WhatsApp for both seller and buyer. This customer submission remains pending shop review and is not an approved shop receipt.',
    };
  }

  private buildCustomerSalesDeclarationPdf(d: any): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 46, info: { Title: 'AURORA Sales Declaration ' + d.declarationRef, Author: 'AURORA E-RECEIPT' } });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      doc.on('error', reject);
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      const line = (label: string, value: unknown) => {
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#17324d').text(label + ': ', { continued: true });
        doc.font('Helvetica').text(String(value ?? '—'));
      };
      const heading = (value: string) => {
        doc.moveDown(.7).font('Helvetica-Bold').fontSize(12).fillColor('#075b74').text(value);
        doc.moveDown(.25);
      };
      doc.font('Helvetica-Bold').fontSize(19).fillColor('#075b74').text('AURORA E-RECEIPT');
      doc.fontSize(15).fillColor('#172b45').text('SALES DECLARATION FORM');
      doc.moveDown(.3).font('Helvetica').fontSize(9).fillColor('#526477').text('Declaration reference: ' + d.declarationRef);
      doc.text('Submitted: ' + new Date(d.createdAt || Date.now()).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }));
      doc.roundedRect(46, doc.y + 8, 504, 38, 5).fill('#fff3cd');
      doc.fillColor('#805b00').font('Helvetica-Bold').fontSize(9).text('CUSTOMER SUBMISSION · PENDING SHOP REVIEW · NOT AN APPROVED SHOP RECEIPT', 56, doc.y + 20, { width: 484, align: 'center' });
      doc.moveDown(3);
      doc.moveTo(46, doc.y).lineTo(550, doc.y).strokeColor('#9bb7c8').stroke();
      heading('SELLER DETAILS');
      line('Full name', d.sellerName); line('National ID / Passport', d.nationalId);
      line('Phone', d.sellerPhone); line('Alternative phone', d.alternativePhone || 'Not supplied');
      line('Email', d.sellerEmail); line('Residential address', d.residentialAddress);
      heading('BUYER DETAILS');
      line('Full name', d.buyerName); line('National ID / Passport', d.buyerNationalId);
      line('Phone', d.buyerPhone); line('Email', d.buyerEmail);
      heading('PRODUCT AND SALE DETAILS');
      line('Product / make and model', d.productName || d.phoneMakeModel);
      line('IMEI / identifier', d.imei1 || 'Not provided'); line('Second identifier', d.imei2 || 'Not provided');
      line('Serial number', d.serialNumber || 'Not provided'); line('Condition', d.condition);
      line('Agreed price', 'KSh ' + Number(d.purchasePriceKes || 0).toLocaleString('en-KE'));
      line('Original purchase receipt', d.saleType === 'with_receipt' ? 'Provided' : 'Not provided');
      if (d.saleType !== 'with_receipt') line('Reason receipt unavailable', d.noReceiptReason || 'Not supplied');
      heading('SELLER OWNERSHIP DECLARATION');
      doc.font('Helvetica').fontSize(9).fillColor('#263746').text('The seller declares that they are the lawful owner of the product recorded above or are authorised to sell it; that, to the best of their knowledge, it is not stolen, unlawfully obtained, fraudulently acquired or subject to an ownership dispute; and that the details supplied are true. The seller accepts responsibility for false statements or an unlawful ownership claim connected with this sale and agrees to cooperate with lawful investigations.');
      heading('CONFIRMATION AND SIGNATURE');
      line('Seller declaration accepted', d.declarationAccepted ? 'Yes' : 'No');
      line('Witness', d.witnessName || 'Not supplied'); line('Witness phone', d.witnessPhone || 'Not supplied');
      const addImage = (label: string, data?: string) => {
        if (!data || !data.startsWith('data:image/')) return;
        try {
          const raw = Buffer.from(data.split(',')[1], 'base64');
          if (doc.y > 640) doc.addPage();
          doc.moveDown(.5).font('Helvetica-Bold').fontSize(9).fillColor('#17324d').text(label);
          doc.image(raw, 46, doc.y, { fit: [230, 110] });
          doc.moveDown(.5);
        } catch {}
      };
      addImage('Seller signature', d.signatureData);
      addImage('Seller thumbprint mark', d.thumbprintData);
      addImage('Seller ID image', d.idPhotoData);
      addImage('Seller photograph', d.sellerPhotoData);
      addImage('Product photograph', d.phonePhotoData);
      addImage('Original purchase receipt image', d.receiptPhotoData);
      doc.moveDown().font('Helvetica').fontSize(8).fillColor('#65758a').text('This is the complete copy of the information and evidence submitted by the customer. It is pending shop review and is not an approved shop receipt. This record does not independently verify identity or establish legal ownership.');
      doc.end();
    });
  }

  @Get('sales-declarations')
  @Roles('customer')
  async listCustomerSalesDeclarations(@Req() req: any) {
    const customerId = req.user?.sub;
    if (!customerId) throw new BadRequestException('Customer account required.');
    const result = await this.db.pool.query(
      `SELECT id, declaration_ref AS "declarationRef", seller_name AS "sellerName",
              product_name AS "productName", status, created_at AS "createdAt"
         FROM customer_sales_declaration_submissions
        WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [customerId],
    );
    return { declarations: result.rows };
  }

  @Post('lookup')
  @Roles('owner', 'manager', 'freelancer')
  async lookup(@Req() req: any, @Body() body: { phone?: string; nationalId?: string }) {
    const { tenantId, storeId } = req.user ?? {};
    if (!tenantId || !storeId) throw new BadRequestException('User is not tied to a store');
    if (typeof body?.phone !== 'string' || typeof body?.nationalId !== 'string') {
      throw new BadRequestException('Enter both the customer phone number and National ID');
    }
    const phone = normalisePhone(body.phone);
    const nationalId = body.nationalId.trim();
    if (!/^[0-9A-Za-z-]{5,30}$/.test(nationalId)) throw new BadRequestException('Enter a valid National ID');
    const nationalIdHash = hashNationalId(nationalId);
    const { rows } = await this.db.pool.query(
      `SELECT c.id,c.full_name AS "fullName",c.phone,c.email,c.national_id_last4 AS "nationalIdLast4",
              c.loyalty_points AS "loyaltyPoints",
              COUNT(DISTINCT r.id) FILTER (WHERE r.status='issued')::int AS "purchaseCount",
              COALESCE(SUM(r.total_kes) FILTER (WHERE r.status='issued'),0)::bigint AS "lifetimeSpendKes",
              MAX(r.issued_at) AS "lastPurchaseAt"
         FROM customers c
         LEFT JOIN receipts r ON r.customer_id=c.id AND r.tenant_id=c.tenant_id AND r.store_id=$2
        WHERE c.tenant_id=$1 AND c.phone=$3 AND c.national_id_hash=$4
        GROUP BY c.id LIMIT 1`,
      [tenantId, storeId, phone, nationalIdHash],
    );
    if (!rows[0]) return { found: false, customer: null, recentReceipts: [] };
    const history = await this.db.pool.query(
      `SELECT r.id,r.receipt_no AS "receiptNo",r.issued_at AS "issuedAt",
              r.total_kes AS "totalKes",r.status,r.payment_method AS "paymentMethod",
              COALESCE(json_agg(json_build_object('name',ri.name,'qty',ri.qty,'lineTotalKes',ri.line_total_kes)
                ORDER BY ri.id) FILTER (WHERE ri.id IS NOT NULL),'[]'::json) AS items
         FROM receipts r LEFT JOIN receipt_items ri ON ri.receipt_id=r.id
        WHERE r.customer_id=$1 AND r.tenant_id=$2 AND r.store_id=$3
        GROUP BY r.id ORDER BY r.issued_at DESC LIMIT 10`,
      [rows[0].id, tenantId, storeId],
    );
    return {
      found: true,
      customer: { ...rows[0], lifetimeSpendKes: Number(rows[0].lifetimeSpendKes) },
      recentReceipts: history.rows.map((r:any)=>({...r,totalKes:Number(r.totalKes)})),
    };
  }

  @Get()
  @Roles('owner', 'manager', 'freelancer')
  async list(@Req() req: any, @Query('q') q?: string, @Query('limit') limit?: string) {
    const { tenantId, storeId } = req.user ?? {};
    if (!tenantId || !storeId) throw new BadRequestException('User is not tied to a store');
    const search = String(q ?? '').trim().slice(0, 100);
    const n = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new BadRequestException('limit must be from 1 to 100');
    const { rows } = await this.db.pool.query(
      `SELECT c.id,c.full_name AS "fullName",c.phone,c.email,c.loyalty_points AS "loyaltyPoints",
              COUNT(DISTINCT r.id) FILTER (WHERE r.status='issued')::int AS "purchaseCount",
              COALESCE(SUM(r.total_kes) FILTER (WHERE r.status='issued'),0)::bigint AS "lifetimeSpendKes",
              MAX(r.issued_at) AS "lastPurchaseAt"
         FROM customers c
         LEFT JOIN receipts r ON r.customer_id=c.id AND r.tenant_id=c.tenant_id AND r.store_id=$2
        WHERE c.tenant_id=$1
          AND ($3='' OR c.full_name ILIKE '%'||$3||'%' OR c.phone ILIKE '%'||$3||'%' OR COALESCE(c.email,'') ILIKE '%'||$3||'%')
        GROUP BY c.id
        ORDER BY MAX(r.issued_at) DESC NULLS LAST,c.full_name ASC LIMIT $4`,
      [tenantId, storeId, search, n],
    );
    return { customers: rows.map((r:any)=>({...r,lifetimeSpendKes:Number(r.lifetimeSpendKes)})) };
  }
}
