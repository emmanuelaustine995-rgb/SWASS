import { BadRequestException, ConflictException, Controller, Get, Post, Body, Req, Param, Res, UseGuards } from '@nestjs/common';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';
import PDFDocument = require('pdfkit');
import { EmailVerificationService } from '../notifications/email-verification.service';
import { WhatsAppReceiptService } from '../notifications/whatsapp-receipt.service';

type DeclarationInput = {
  sellerName?: string; nationalId?: string; sellerPhone?: string; sellerEmail?: string; alternativePhone?: string;
  buyerName?: string; buyerNationalId?: string; buyerPhone?: string; buyerEmail?: string;
  residentialAddress?: string; phoneMakeModel?: string; productName?: string; imei1?: string; imei2?: string;
  serialNumber?: string; condition?: string; purchasePriceKes?: number; receivedAt?: string;
  noReceiptReason?: string; saleType?: string; receiptPhotoData?: string; sellerPhotoData?: string; idPhotoData?: string; phonePhotoData?: string;
  signatureData?: string; thumbprintData?: string; witnessName?: string; witnessPhone?: string;
  declarationAccepted?: boolean; shopAcknowledged?: boolean;
};

@Controller('api/v1/second-hand-phone-declarations')
@UseGuards(AuthGuard, RolesGuard)
export class SecondHandPhoneDeclarationsController {
  constructor(private db: DbService, private email: EmailVerificationService, private whatsapp: WhatsAppReceiptService) {}

  @Get()
  @Roles('owner','freelancer')
  async list(@Req() req: any) {
    const user = req.user;
    this.requireStore(user);
    const { rows } = await this.db.pool.query(
      `SELECT id, seller_name AS "sellerName", national_id AS "nationalId",
               seller_phone AS "sellerPhone", seller_email AS "sellerEmail", buyer_name AS "buyerName", buyer_national_id AS "buyerNationalId", buyer_phone AS "buyerPhone", buyer_email AS "buyerEmail", phone_make_model AS "phoneMakeModel", sale_type AS "saleType",
              imei1, imei2, serial_number AS "serialNumber", phone_condition AS "condition", purchase_price_kes AS "purchasePriceKes",
              declaration_ref AS "declarationRef", created_at AS "createdAt"
         FROM second_hand_phone_declarations
        WHERE tenant_id=$1 AND store_id=$2
        ORDER BY created_at DESC LIMIT 50`,
      [user.tenantId, user.storeId],
    );
    return { declarations: rows };
  }

  @Post()
  @Roles('owner','freelancer')
  async create(@Req() req: any, @Body() body: DeclarationInput) {
    const user = req.user;
    this.requireStore(user);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('A seller declaration is required.');

    const text = (value: unknown, label: string, max: number, required = true) => {
      if (value === undefined || value === null || value === '') {
        if (required) throw new BadRequestException(label + ' is required.');
        return null;
      }
      if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) {
        throw new BadRequestException(label + ' is invalid or too long.');
      }
      return value.trim();
    };
    const image = (value: unknown, label: string, required = false) => {
      if (value === undefined || value === null || value === '') {
        if (required) throw new BadRequestException(label + ' is required.');
        return null;
      }
      if (typeof value !== 'string' || value.length > 85000 ||
          !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) {
        throw new BadRequestException(label + ' must be a valid compressed image.');
      }
      return value;
    };

    const sellerName = text(body.sellerName, 'Seller full name', 160)!;
    const nationalId = text(body.nationalId, 'National ID or passport number', 40)!;
    const sellerPhone = text(body.sellerPhone, 'Seller phone', 30)!;
    const sellerEmail = text(body.sellerEmail, 'Seller email', 254)!;
    const buyerName = text(body.buyerName, 'Buyer full name', 160)!;
    const buyerNationalId = text(body.buyerNationalId, 'Buyer National ID', 40)!;
    const buyerPhone = text(body.buyerPhone, 'Buyer phone', 30)!;
    const buyerEmail = text(body.buyerEmail, 'Buyer email', 254)!;
    const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    if (!validEmail(sellerEmail) || !validEmail(buyerEmail)) throw new BadRequestException('Enter valid seller and buyer email addresses.');
    const alternativePhone = text(body.alternativePhone, 'Alternative phone', 30, false);
    const residentialAddress = text(body.residentialAddress, 'Residential address', 300)!;
    const phoneMakeModel = text(body.productName ?? body.phoneMakeModel, 'Product name / make and model', 160)!;
    const imei1 = text(body.imei1, 'Product identifier / IMEI', 40, false) ?? '';
    const imei2 = text(body.imei2, 'Second product identifier', 40, false);
    const serialNumber = text(body.serialNumber, 'Serial number', 100, false);
    const condition = text(body.condition, 'Product condition', 40)!;
    const saleType = body.saleType === 'with_receipt' ? 'with_receipt' : body.saleType === 'without_receipt' ? 'without_receipt' : null;
    if (!saleType) throw new BadRequestException('Choose whether the seller has the original purchase receipt.');
    const noReceiptReason = text(body.noReceiptReason, 'Receipt status / missing receipt explanation', 1000)!;
    const witnessName = text(body.witnessName, 'Witness name', 160, false);
    const witnessPhone = text(body.witnessPhone, 'Witness phone', 30, false);
    if (imei1.length > 40 || (imei2 && imei2.length > 40)) throw new BadRequestException('Product identifier is too long.');
    const lostIds=[imei1,imei2||'',serialNumber||''].map(v=>v.toUpperCase().replace(/[^A-Z0-9]/g,'')).filter(v=>v.length>=6);
    if(lostIds.length){
      const match=await this.db.pool.query(`SELECT li.item_code AS "itemCode",li.item_name AS "itemName",li.brand,li.model,li.colour,li.ob_number AS "obNumber",li.lost_at AS "lostAt",u.full_name AS "registeredByName",u.email AS "registeredByEmail",u.phone AS "registeredByPhone"
        FROM lost_items li LEFT JOIN users u ON u.id=li.registered_by WHERE li.status='lost' AND (
          upper(regexp_replace(COALESCE(li.imei_1,''),'[^A-Za-z0-9]','','g'))=ANY($1::text[]) OR upper(regexp_replace(COALESCE(li.imei_2,''),'[^A-Za-z0-9]','','g'))=ANY($1::text[]) OR upper(regexp_replace(COALESCE(li.serial_number,''),'[^A-Za-z0-9]','','g'))=ANY($1::text[])
        ) ORDER BY li.lost_at DESC NULLS LAST LIMIT 1`,[lostIds]);
      if(match.rows[0]){
        const lost=match.rows[0];
        const shopResult=await this.db.pool.query(`SELECT t.name AS "shopName",t.phone AS "shopPhone",t.email AS "shopEmail",s.name AS "branchName",s.location AS "shopLocation" FROM tenants t JOIN stores s ON s.tenant_id=t.id WHERE t.id=$1 AND s.id=$2 LIMIT 1`,[user.tenantId,user.storeId]);
        const shop=shopResult.rows[0]||{};
        const matchedIdentifier=lostIds[0]||'not supplied';
        const warning=`URGENT AURORA LOST ITEM ALERT. ${lost.itemName||phoneMakeModel} (${lost.brand||''} ${lost.model||''} ${lost.colour||''}) reference ${lost.itemCode} is recorded as LOST. Matched IMEI/serial: ${matchedIdentifier}. OB number: ${lost.obNumber||'not supplied'}. Reported lost on: ${lost.lostAt?new Date(lost.lostAt).toISOString():'not recorded'}. Attempting shop: ${shop.shopName||'not available'} / ${shop.branchName||'branch unavailable'} at ${shop.shopLocation||'location unavailable'}. Attempted second-hand seller: ${sellerName}, phone ${sellerPhone}. Buyer: ${buyerName}, phone ${buyerPhone}. The transaction has been blocked. Do not confront anyone; preserve this information and contact the appropriate authorities.`;
        const tasks:Promise<any>[]=[];
        if(lost.registeredByEmail)tasks.push(this.email.sendLostItemAlert({to:lost.registeredByEmail,recipientName:lost.registeredByName||'AURORA user',itemName:lost.itemName||phoneMakeModel,itemCode:lost.itemCode,warning}));
        if(lost.registeredByPhone)tasks.push(this.whatsapp.sendText({to:lost.registeredByPhone,text:warning}));
        if(shop.shopEmail)tasks.push(this.email.sendLostItemAlert({to:shop.shopEmail,recipientName:shop.shopName||'Shop owner',itemName:lost.itemName||phoneMakeModel,itemCode:lost.itemCode,warning}));
        if(shop.shopPhone)tasks.push(this.whatsapp.sendText({to:shop.shopPhone,text:warning}));
        if(buyerEmail)tasks.push(this.email.sendLostItemAlert({to:buyerEmail,recipientName:buyerName,itemName:lost.itemName||phoneMakeModel,itemCode:lost.itemCode,warning}));
        if(buyerPhone)tasks.push(this.whatsapp.sendText({to:buyerPhone,text:warning}));
        await Promise.allSettled(tasks);
        throw new ConflictException('AURORA RED ALERT: This phone/identifier is recorded as LOST (reference '+lost.itemCode+'). The second-hand sale is blocked. Alert delivery was attempted through the available contact channels.');
      }
    }
    if (!['New', 'Excellent', 'Good', 'Fair', 'Faulty'].includes(condition)) throw new BadRequestException('Select a valid phone condition.');
    if (!Number.isSafeInteger(body.purchasePriceKes) || body.purchasePriceKes! < 1 || body.purchasePriceKes! > 100000000) {
      throw new BadRequestException('Enter a valid agreed purchase price in KSh.');
    }
    if (body.declarationAccepted !== true) throw new BadRequestException('The seller must accept the ownership and responsibility declaration.');
    if (body.shopAcknowledged !== true) throw new BadRequestException('The shop representative must confirm the seller and phone checks.');
    const sellerPhotoData = image(body.sellerPhotoData, 'Seller photo', saleType === 'without_receipt');
    const receiptPhotoData = image(body.receiptPhotoData, 'Original purchase receipt photo', saleType === 'with_receipt');
    if (saleType === 'without_receipt' && receiptPhotoData) throw new BadRequestException('Receipt photo must be omitted when the seller has no original receipt.');
    const idPhotoData = image(body.idPhotoData, 'Seller ID photo', true);
    const phonePhotoData = image(body.phonePhotoData, 'Phone photo', true);
    const signatureData = image(body.signatureData, 'Seller signature', true);
    const thumbprintData = image(body.thumbprintData, 'Electronic thumbprint mark', saleType === 'without_receipt');

    const declarationRef = 'AUR-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
    const { rows } = await this.db.pool.query(
      `INSERT INTO second_hand_phone_declarations
       (tenant_id, store_id, recorded_by, declaration_ref, seller_name, national_id, seller_phone,
        alternative_phone, residential_address, phone_make_model, imei1, imei2, serial_number,
        phone_condition, purchase_price_kes, no_receipt_reason, sale_type, receipt_photo_data, seller_photo_data, id_photo_data,
        phone_photo_data, signature_data, thumbprint_data, witness_name, witness_phone,
        seller_email, buyer_name, buyer_national_id, buyer_phone, buyer_email,
        declaration_accepted, shop_acknowledged, shop_acknowledged_at, declaration_version, accepted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,true,true,now(),'2026-11-v3',now())
       RETURNING id, declaration_ref AS "declarationRef", seller_name AS "sellerName",
        national_id AS "nationalId", seller_phone AS "sellerPhone", seller_email AS "sellerEmail",
        buyer_name AS "buyerName", buyer_national_id AS "buyerNationalId", buyer_phone AS "buyerPhone", buyer_email AS "buyerEmail",
        alternative_phone AS "alternativePhone", residential_address AS "residentialAddress", phone_make_model AS "phoneMakeModel",
        imei1, imei2, serial_number AS "serialNumber", phone_condition AS "condition",
        purchase_price_kes AS "purchasePriceKes", no_receipt_reason AS "noReceiptReason",
        sale_type AS "saleType", receipt_photo_data AS "receiptPhotoData", receipt_photo_data AS "receiptPhotoData", seller_photo_data AS "sellerPhotoData", id_photo_data AS "idPhotoData",
        phone_photo_data AS "phonePhotoData", signature_data AS "signatureData",
        thumbprint_data AS "thumbprintData", witness_name AS "witnessName",
        witness_phone AS "witnessPhone", seller_email AS "sellerEmail", buyer_name AS "buyerName",
        buyer_national_id AS "buyerNationalId", buyer_phone AS "buyerPhone", buyer_email AS "buyerEmail",
        declaration_accepted AS "declarationAccepted", shop_acknowledged AS "shopAcknowledged",
        accepted_at AS "acceptedAt", created_at AS "createdAt"`,
      [user.tenantId, user.storeId, user.sub, declarationRef, sellerName, nationalId, sellerPhone,
       alternativePhone, residentialAddress, phoneMakeModel, imei1.replace(/\s+/g, ''), imei2?.replace(/\s+/g, '') ?? null,
       serialNumber, condition, body.purchasePriceKes, noReceiptReason, saleType, receiptPhotoData, sellerPhotoData, idPhotoData,
       phonePhotoData, signatureData, thumbprintData, witnessName, witnessPhone,
       sellerEmail, buyerName, buyerNationalId, buyerPhone, buyerEmail],
    );

    const declaration = { ...rows[0], shopRepresentativeName: user.fullName || 'Shop owner' };
    const pdf = await this.buildSecondHandPdf(declaration);
    const deliver = async (task: () => Promise<any>) => {
      try { const result = await task(); return { sent: !!result?.sent, reason: null as string | null }; }
      catch (error) { return { sent: false, reason: error instanceof Error ? error.message : 'Delivery failed' }; }
    };
    const [sellerEmailDelivery, buyerEmailDelivery, sellerWhatsappDelivery, buyerWhatsappDelivery] = await Promise.all([
      deliver(() => this.email.sendSecondHandReceipt({to:sellerEmail,recipientName:sellerName,reference:declarationRef,productName:phoneMakeModel,sellerName,buyerName,pdf})),
      deliver(() => this.email.sendSecondHandReceipt({to:buyerEmail,recipientName:buyerName,reference:declarationRef,productName:phoneMakeModel,sellerName,buyerName,pdf})),
      deliver(() => this.whatsapp.sendPdf({to:sellerPhone,receiptNo:declarationRef,businessName:'AURORA E-RECEIPT',pdf})),
      deliver(() => this.whatsapp.sendPdf({to:buyerPhone,receiptNo:declarationRef,businessName:'AURORA E-RECEIPT',pdf})),
    ]);
    return { declaration, pdfBase64: pdf.toString('base64'), delivery: {
      seller: { email: sellerEmailDelivery, whatsapp: sellerWhatsappDelivery },
      buyer: { email: buyerEmailDelivery, whatsapp: buyerWhatsappDelivery },
    } };
  }

  @Get(':id/pdf')
  @Roles('owner','freelancer')
  async pdf(@Req() req: any, @Param('id') id: string, @Res() res: any) {
    const user = req.user;
    this.requireStore(user);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new BadRequestException('Invalid Special Receipt reference.');
    }
    const { rows } = await this.db.pool.query(
      `SELECT id, declaration_ref AS "declarationRef", seller_name AS "sellerName",
        national_id AS "nationalId", seller_phone AS "sellerPhone", seller_email AS "sellerEmail",
        alternative_phone AS "alternativePhone", residential_address AS "residentialAddress",
        phone_make_model AS "phoneMakeModel", imei1, imei2, serial_number AS "serialNumber",
        phone_condition AS "condition", purchase_price_kes AS "purchasePriceKes",
        no_receipt_reason AS "noReceiptReason", sale_type AS "saleType",
        receipt_photo_data AS "receiptPhotoData", seller_photo_data AS "sellerPhotoData",
        id_photo_data AS "idPhotoData", phone_photo_data AS "phonePhotoData",
        signature_data AS "signatureData", thumbprint_data AS "thumbprintData",
        witness_name AS "witnessName", witness_phone AS "witnessPhone",
        declaration_accepted AS "declarationAccepted", shop_acknowledged AS "shopAcknowledged",
        buyer_name AS "buyerName", buyer_national_id AS "buyerNationalId",
        buyer_phone AS "buyerPhone", buyer_email AS "buyerEmail", accepted_at AS "acceptedAt",
        created_at AS "createdAt"
       FROM second_hand_phone_declarations
       WHERE id=$1 AND tenant_id=$2 AND store_id=$3 LIMIT 1`,
      [id, user.tenantId, user.storeId],
    );
    if (!rows[0]) throw new BadRequestException('Second-Hand Receipt not found in this shop.');
    const pdf = await this.buildSecondHandPdf({ ...rows[0], shopRepresentativeName: user.fullName || 'Shop owner' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="AURORA-Second-Hand-${rows[0].declarationRef}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(pdf);
  }

  @Get(':id')
  @Roles('owner','freelancer')
  async getOne(@Req() req: any, @Param('id') id: string) {
    const user = req.user;
    this.requireStore(user);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new BadRequestException('Invalid declaration reference.');
    }
    const { rows } = await this.db.pool.query(
      `SELECT id, declaration_ref AS "declarationRef", seller_name AS "sellerName",
        national_id AS "nationalId", seller_phone AS "sellerPhone", seller_email AS "sellerEmail",
        alternative_phone AS "alternativePhone", residential_address AS "residentialAddress", phone_make_model AS "phoneMakeModel",
        imei1, imei2, serial_number AS "serialNumber", phone_condition AS "condition",
        purchase_price_kes AS "purchasePriceKes", no_receipt_reason AS "noReceiptReason",
        seller_photo_data AS "sellerPhotoData", id_photo_data AS "idPhotoData",
        phone_photo_data AS "phonePhotoData", signature_data AS "signatureData",
        thumbprint_data AS "thumbprintData", witness_name AS "witnessName",
        witness_phone AS "witnessPhone", declaration_accepted AS "declarationAccepted",
        shop_acknowledged AS "shopAcknowledged", buyer_name AS "buyerName", buyer_national_id AS "buyerNationalId",
        buyer_phone AS "buyerPhone", buyer_email AS "buyerEmail", accepted_at AS "acceptedAt", created_at AS "createdAt"
       FROM second_hand_phone_declarations
       WHERE id=$1 AND tenant_id=$2 AND store_id=$3 LIMIT 1`,
      [id, user.tenantId, user.storeId],
    );
    if (!rows[0]) throw new BadRequestException('Declaration not found in this shop.');
    return { declaration: { ...rows[0], shopRepresentativeName: user.fullName || 'Shop owner' } };
  }


  @Get(':id/amendments')
  @Roles('owner','freelancer')
  async listAmendments(@Req() req: any, @Param('id') id: string) {
    const user = req.user;
    this.requireStore(user);
    const rows = await this.db.pool.query(
      `SELECT a.id, a.version_no AS "versionNo", a.reason, a.changes,
              a.created_at AS "createdAt", a.amended_by AS "amendedBy"
         FROM second_hand_declaration_amendments a
         JOIN second_hand_phone_declarations d ON d.id=a.declaration_id
        WHERE a.declaration_id=$1 AND d.tenant_id=$2 AND d.store_id=$3
        ORDER BY a.version_no DESC`,
      [id, user.tenantId, user.storeId],
    );
    return { amendments: rows.rows };
  }

  @Post(':id/amendments')
  @Roles('owner','freelancer')
  async amend(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const user = req.user;
    this.requireStore(user);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new BadRequestException('Invalid Special Receipt reference.');
    }
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    const changes = body?.changes;
    if (!reason || reason.length > 1000) throw new BadRequestException('Explain why this declaration is being amended.');
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) {
      throw new BadRequestException('Enter at least one amendment.');
    }
    const allowed = new Set(['sellerName','nationalId','sellerPhone','alternativePhone','residentialAddress','productName','imei1','imei2','serialNumber','condition','purchasePriceKes','receiptStatus','witnessName','witnessPhone']);
    const clean: Record<string, string | number | null> = {};
    for (const [key, value] of Object.entries(changes)) {
      if (!allowed.has(key)) throw new BadRequestException('This field cannot be amended.');
      if (value !== null && typeof value !== 'string' && typeof value !== 'number') throw new BadRequestException('Invalid amendment value.');
      if (typeof value === 'string' && value.length > 1000) throw new BadRequestException('Amendment value is too long.');
      if (key === 'purchasePriceKes' && (!Number.isSafeInteger(value) || Number(value) < 1)) throw new BadRequestException('Enter a valid purchase price.');
      if (key === 'condition' && !['New','Excellent','Good','Fair','Faulty'].includes(String(value))) throw new BadRequestException('Select a valid product condition.');
      clean[key] = value as string | number | null;
    }
    const saved = await this.db.tx(async (client) => {
      const declaration = await client.query(
        `SELECT id FROM second_hand_phone_declarations
          WHERE id=$1 AND tenant_id=$2 AND store_id=$3 FOR UPDATE`,
        [id, user.tenantId, user.storeId],
      );
      if (!declaration.rowCount) throw new BadRequestException('Special Receipt not found in this shop.');
      const version = await client.query(
        `SELECT COALESCE(MAX(version_no),1)+1 AS next_version
           FROM second_hand_declaration_amendments WHERE declaration_id=$1`,
        [id],
      );
      const inserted = await client.query(
        `INSERT INTO second_hand_declaration_amendments
         (declaration_id,tenant_id,store_id,amended_by,version_no,reason,changes)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
         RETURNING id, version_no AS "versionNo", reason, changes, created_at AS "createdAt"`,
        [id,user.tenantId,user.storeId,user.sub,Number(version.rows[0].next_version),reason,JSON.stringify(clean)],
      );
      return inserted.rows[0];
    });
    return { amendment: saved, originalPreserved: true };
  }

  private buildSecondHandPdf(d: any): Promise<Buffer> {
    return new Promise((resolve,reject)=>{
      const doc=new PDFDocument({size:'A4',margin:46,info:{Title:'AURORA Second-Hand Receipt '+d.declarationRef,Author:'AURORA E-RECEIPT'}});
      const chunks:Buffer[]=[];
      doc.on('data',(chunk:Buffer)=>chunks.push(Buffer.from(chunk)));
      doc.on('error',reject);
      doc.on('end',()=>resolve(Buffer.concat(chunks)));
      const line=(label:string,value:unknown)=>{doc.font('Helvetica-Bold').fontSize(9).fillColor('#17324d').text(label+': ',{continued:true});doc.font('Helvetica').text(String(value??'—'));};
      const heading=(value:string)=>{doc.moveDown(.7).font('Helvetica-Bold').fontSize(12).fillColor('#075b74').text(value);doc.moveDown(.25);};
      doc.font('Helvetica-Bold').fontSize(19).fillColor('#075b74').text('AURORA E-RECEIPT');
      doc.fontSize(15).fillColor('#172b45').text('SALES DECLARATION FORM');
      doc.moveDown(.3).font('Helvetica').fontSize(9).fillColor('#526477').text('Receipt reference: '+d.declarationRef);
      doc.text('Issued: '+new Date(d.createdAt||Date.now()).toLocaleString('en-KE',{timeZone:'Africa/Nairobi'}));
      doc.moveDown().moveTo(46,doc.y).lineTo(550,doc.y).strokeColor('#9bb7c8').stroke();
      heading('1 · SELLER IDENTIFICATION');line('Full legal name',d.sellerName);line('National ID / Passport',d.nationalId);line('Phone number',d.sellerPhone);line('Email address',d.sellerEmail);line('Alternative phone',d.alternativePhone||'Not supplied');line('Residential address / area',d.residentialAddress);
      heading('2 · BUYER DETAILS');line('Full legal name',d.buyerName);line('National ID / Passport',d.buyerNationalId);line('Phone number',d.buyerPhone);line('Email address',d.buyerEmail);
      heading('3 · PRODUCT AND SALE DETAILS');line('Product name / make and model',d.phoneMakeModel);line('Product identifier / barcode / IMEI',d.imei1||'Not provided');line('Second identifier',d.imei2||'Not provided');line('Additional serial number / identifying details',d.serialNumber||'Not provided');line('Product condition',d.condition);line('Agreed purchase price','KSh '+Number(d.purchasePriceKes||0).toLocaleString('en-KE'));line('Declaration option',d.saleType==='with_receipt'?'WITH ORIGINAL RECEIPT':'WITHOUT ORIGINAL RECEIPT');line('Original purchase receipt',d.saleType==='with_receipt'?'Provided — photograph attached':'Not provided');if(d.saleType!=='with_receipt')line('Seller explanation for missing receipt',d.noReceiptReason||'Not supplied');
      heading('4 · SELLER OWNERSHIP AND RESPONSIBILITY DECLARATION — EXACT FORM WORDING');
      const declarationText=d.saleType==='with_receipt'
        ? 'I declare that I am the lawful owner of the product recorded above or have full legal authority to sell it. I confirm that the original purchase receipt shown and attached to this record relates to this product and, to the best of my knowledge, is genuine and has not been altered. I confirm that the product is not stolen, unlawfully obtained, fraudulently acquired or subject to an ownership dispute, and that all product identifiers and details I have supplied are true. I accept responsibility for false statements, a false or altered receipt, fraudulent representation or an unlawful ownership claim connected with this sale. I agree to cooperate with lawful investigations and provide further information when lawfully required. I understand that this declaration may be retained and disclosed to lawful authorities when required.'
        : 'I declare that I am the lawful owner of the product recorded above or have full legal authority to sell it, even though I cannot provide its original purchase receipt. I have truthfully explained why the receipt is unavailable and confirm that, to the best of my knowledge, the product is not stolen, unlawfully obtained, fraudulently acquired or subject to an ownership dispute. I confirm that all product identifiers and details I have supplied are true and have not knowingly been altered. I accept responsibility for false statements, fraudulent representation or an unlawful ownership claim connected with this sale. I agree to cooperate with lawful investigations and provide further information when lawfully required. I understand that this declaration may be retained and disclosed to lawful authorities when required.';
      doc.font('Helvetica').fontSize(9).fillColor('#263746').text(declarationText,{align:'justify'});
      heading('5 · ELECTRONIC SIGNATURES, THUMBPRINT AND SHOP CONFIRMATION');
      line('Seller confirmed declaration was read and understood',d.declarationAccepted?'Yes':'No');
      line('Shop representative',d.shopRepresentativeName||'Not supplied');
      line('Shop representative checked seller ID and product identifiers',d.shopAcknowledged?'Yes':'No');
      line('Witness full name',d.witnessName||'Not supplied');line('Witness phone',d.witnessPhone||'Not supplied');
      line('Server recorded date and time',new Date(d.createdAt||Date.now()).toLocaleString('en-KE',{timeZone:'Africa/Nairobi'}));
      const addImage=(label:string,data?:string)=>{if(!data||!data.startsWith('data:image/'))return;try{const raw=Buffer.from(data.split(',')[1],'base64');if(doc.y>640)doc.addPage();doc.moveDown(.5).font('Helvetica-Bold').fontSize(9).fillColor('#17324d').text(label);doc.image(raw,46,doc.y,{fit:[230,110]});doc.moveDown(.5);}catch{}};
      addImage('Seller electronic signature',d.signatureData);addImage('Seller electronic thumbprint mark (drawn, not biometric scan)',d.thumbprintData);addImage('Seller ID photo (front)',d.idPhotoData);addImage('Seller / client photograph',d.sellerPhotoData);addImage('Product and identifying-details photograph',d.phonePhotoData);addImage('Original purchase receipt photograph',d.receiptPhotoData);
      doc.moveDown().font('Helvetica').fontSize(8).fillColor('#65758a').text('This record documents the information and declarations supplied by the parties. It does not independently verify identity, establish legal ownership or guarantee a court outcome.');
      doc.end();
    });
  }

  private requireStore(user: any) {
    if (!user?.tenantId || !user?.storeId) throw new BadRequestException('This account is not linked to a shop.');
    if (!['owner','freelancer'].includes(user.role)) throw new BadRequestException('A linked shop account is required to record second-hand phone purchases.');
  }
}
