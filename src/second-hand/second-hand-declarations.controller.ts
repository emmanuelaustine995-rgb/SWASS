import { BadRequestException, Controller, Get, Post, Body, Req, Param, UseGuards } from '@nestjs/common';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';

type DeclarationInput = {
  sellerName?: string; nationalId?: string; sellerPhone?: string; alternativePhone?: string;
  residentialAddress?: string; phoneMakeModel?: string; imei1?: string; imei2?: string;
  serialNumber?: string; condition?: string; purchasePriceKes?: number; receivedAt?: string;
  noReceiptReason?: string; sellerPhotoData?: string; idPhotoData?: string; phonePhotoData?: string;
  signatureData?: string; thumbprintData?: string; witnessName?: string; witnessPhone?: string;
  declarationAccepted?: boolean;
};

@Controller('api/v1/second-hand-phone-declarations')
@UseGuards(AuthGuard, RolesGuard)
export class SecondHandPhoneDeclarationsController {
  constructor(private db: DbService) {}

  @Get()
  @Roles('owner')
  async list(@Req() req: any) {
    const user = req.user;
    this.requireStore(user);
    const { rows } = await this.db.pool.query(
      `SELECT id, seller_name AS "sellerName", national_id AS "nationalId",
              seller_phone AS "sellerPhone", phone_make_model AS "phoneMakeModel",
              imei1, imei2, purchase_price_kes AS "purchasePriceKes",
              declaration_ref AS "declarationRef", created_at AS "createdAt"
         FROM second_hand_phone_declarations
        WHERE tenant_id=$1 AND store_id=$2
        ORDER BY created_at DESC LIMIT 50`,
      [user.tenantId, user.storeId],
    );
    return { declarations: rows };
  }

  @Post()
  @Roles('owner')
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
    const alternativePhone = text(body.alternativePhone, 'Alternative phone', 30, false);
    const residentialAddress = text(body.residentialAddress, 'Residential address', 300)!;
    const phoneMakeModel = text(body.phoneMakeModel, 'Phone make and model', 160)!;
    const imei1 = text(body.imei1, 'IMEI 1', 20)!;
    const imei2 = text(body.imei2, 'IMEI 2', 20, false);
    const serialNumber = text(body.serialNumber, 'Serial number', 100, false);
    const condition = text(body.condition, 'Phone condition', 40)!;
    const noReceiptReason = text(body.noReceiptReason, 'Reason for missing receipt', 1000)!;
    const witnessName = text(body.witnessName, 'Witness name', 160, false);
    const witnessPhone = text(body.witnessPhone, 'Witness phone', 30, false);
    if (!/^\d{14,16}$/.test(imei1.replace(/\s+/g, ''))) throw new BadRequestException('Enter a valid 14–16 digit IMEI 1.');
    if (imei2 && !/^\d{14,16}$/.test(imei2.replace(/\s+/g, ''))) throw new BadRequestException('Enter a valid 14–16 digit IMEI 2.');
    if (!['New', 'Excellent', 'Good', 'Fair', 'Faulty'].includes(condition)) throw new BadRequestException('Select a valid phone condition.');
    if (!Number.isSafeInteger(body.purchasePriceKes) || body.purchasePriceKes! < 1 || body.purchasePriceKes! > 100000000) {
      throw new BadRequestException('Enter a valid agreed purchase price in KSh.');
    }
    if (body.declarationAccepted !== true) throw new BadRequestException('The seller must accept the ownership and responsibility declaration.');
    const sellerPhotoData = image(body.sellerPhotoData, 'Seller photo');
    const idPhotoData = image(body.idPhotoData, 'Seller ID photo', true);
    const phonePhotoData = image(body.phonePhotoData, 'Phone photo', true);
    const signatureData = image(body.signatureData, 'Seller signature', true);
    const thumbprintData = image(body.thumbprintData, 'Electronic thumbprint mark', true);

    const declarationRef = 'AUR-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
    const { rows } = await this.db.pool.query(
      `INSERT INTO second_hand_phone_declarations
       (tenant_id, store_id, recorded_by, declaration_ref, seller_name, national_id, seller_phone,
        alternative_phone, residential_address, phone_make_model, imei1, imei2, serial_number,
        phone_condition, purchase_price_kes, no_receipt_reason, seller_photo_data, id_photo_data,
        phone_photo_data, signature_data, thumbprint_data, witness_name, witness_phone,
        declaration_accepted, declaration_version, accepted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,true,'2026-11-v1',now())
       RETURNING id, declaration_ref AS "declarationRef", seller_name AS "sellerName",
        national_id AS "nationalId", seller_phone AS "sellerPhone", alternative_phone AS "alternativePhone",
        residential_address AS "residentialAddress", phone_make_model AS "phoneMakeModel",
        imei1, imei2, serial_number AS "serialNumber", phone_condition AS "condition",
        purchase_price_kes AS "purchasePriceKes", no_receipt_reason AS "noReceiptReason",
        seller_photo_data AS "sellerPhotoData", id_photo_data AS "idPhotoData",
        phone_photo_data AS "phonePhotoData", signature_data AS "signatureData",
        thumbprint_data AS "thumbprintData", witness_name AS "witnessName",
        witness_phone AS "witnessPhone", declaration_accepted AS "declarationAccepted",
        accepted_at AS "acceptedAt", created_at AS "createdAt"`,
      [user.tenantId, user.storeId, user.sub, declarationRef, sellerName, nationalId, sellerPhone,
       alternativePhone, residentialAddress, phoneMakeModel, imei1.replace(/\s+/g, ''), imei2?.replace(/\s+/g, '') ?? null,
       serialNumber, condition, body.purchasePriceKes, noReceiptReason, sellerPhotoData, idPhotoData,
       phonePhotoData, signatureData, thumbprintData, witnessName, witnessPhone],
    );
    return { declaration: rows[0] };
  }

  @Get(':id')
  @Roles('owner')
  async getOne(@Req() req: any, @Param('id') id: string) {
    const user = req.user;
    this.requireStore(user);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new BadRequestException('Invalid declaration reference.');
    }
    const { rows } = await this.db.pool.query(
      `SELECT id, declaration_ref AS "declarationRef", seller_name AS "sellerName",
        national_id AS "nationalId", seller_phone AS "sellerPhone", alternative_phone AS "alternativePhone",
        residential_address AS "residentialAddress", phone_make_model AS "phoneMakeModel",
        imei1, imei2, serial_number AS "serialNumber", phone_condition AS "condition",
        purchase_price_kes AS "purchasePriceKes", no_receipt_reason AS "noReceiptReason",
        seller_photo_data AS "sellerPhotoData", id_photo_data AS "idPhotoData",
        phone_photo_data AS "phonePhotoData", signature_data AS "signatureData",
        thumbprint_data AS "thumbprintData", witness_name AS "witnessName",
        witness_phone AS "witnessPhone", declaration_accepted AS "declarationAccepted",
        accepted_at AS "acceptedAt", created_at AS "createdAt"
       FROM second_hand_phone_declarations
       WHERE id=$1 AND tenant_id=$2 AND store_id=$3 LIMIT 1`,
      [id, user.tenantId, user.storeId],
    );
    if (!rows[0]) throw new BadRequestException('Declaration not found in this shop.');
    return { declaration: rows[0] };
  }

  private requireStore(user: any) {
    if (!user?.tenantId || !user?.storeId) throw new BadRequestException('This account is not linked to a shop.');
    if (user.role !== 'owner') throw new BadRequestException('Only the shop owner can record second-hand phone purchases.');
  }
}
