import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';
import * as QRCode from 'qrcode';
import { EmailVerificationService } from '../notifications/email-verification.service';
import { WhatsAppReceiptService } from '../notifications/whatsapp-receipt.service';

@Controller('api/v1/lost-items')
@UseGuards(AuthGuard, RolesGuard)
export class LostItemsController {
  constructor(private db: DbService, private email: EmailVerificationService, private whatsapp: WhatsAppReceiptService) {}
  private scope(user:any){if(!user.tenantId||!user.storeId)throw new BadRequestException('Shop details are unavailable');return [user.tenantId,user.storeId];}
  @Get('check') @Roles('owner','manager','cashier','vendor','freelancer')
  async checkIdentifier(@Query('identifier') identifier?:string){
    const normalized=String(identifier||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
    if(normalized.length<6||normalized.length>40)throw new BadRequestException('Enter a valid IMEI or serial number (at least 6 characters).');
    const {rows}=await this.db.pool.query(`SELECT item_code AS "itemCode",item_name AS "itemName",brand,model,colour,status FROM lost_items WHERE status='lost' AND (
      upper(regexp_replace(COALESCE(imei_1,''),'[^A-Za-z0-9]','','g'))=$1 OR upper(regexp_replace(COALESCE(imei_2,''),'[^A-Za-z0-9]','','g'))=$1 OR upper(regexp_replace(COALESCE(serial_number,''),'[^A-Za-z0-9]','','g'))=$1
    ) ORDER BY lost_at DESC NULLS LAST LIMIT 1`,[normalized]);
    return rows[0]?{match:true,item:rows[0]}:{match:false};
  }
  @Get() @Roles('owner','manager')
  async list(@Req() req:any){
    const [t,s]=this.scope(req.user);
    const {rows}=await this.db.pool.query(`SELECT li.id,li.item_code AS "itemCode",li.item_name AS "itemName",li.brand,li.model,li.colour,li.description,li.imei_1 AS "imei1",li.imei_2 AS "imei2",li.serial_number AS "serialNumber",li.purchase_date AS "purchaseDate",li.receipt_reference AS "receiptReference",li.status,li.lost_at AS "lostAt",li.created_at AS "createdAt",COUNT(r.id)::int AS "reportCount" FROM lost_items li LEFT JOIN lost_item_reports r ON r.lost_item_id=li.id WHERE li.tenant_id=$1 AND li.store_id=$2 GROUP BY li.id ORDER BY li.created_at DESC LIMIT 200`,[t,s]);
    return {items:rows};
  }
  @Post() @Roles('owner','manager')
  async create(@Req() req:any,@Body() b:any){
    const [t,s]=this.scope(req.user);
    for(const k of ['itemName'])if(typeof b?.[k]!=='string'||!b[k].trim())throw new BadRequestException('Item name is required');
    const imei1=String(b.imei1||'').trim(),imei2=String(b.imei2||'').trim(),serial=String(b.serialNumber||'').trim();
    if(!imei1&&!imei2&&!serial)throw new BadRequestException('Enter at least one IMEI or serial number so the item can be identified');
    for(const v of [imei1,imei2])if(v&&!/^[A-Za-z0-9 -]{6,30}$/.test(v))throw new BadRequestException('Check the IMEI number');
    const normalized=[imei1,imei2,serial].filter(Boolean);
    const duplicate=await this.db.pool.query(`SELECT item_code AS "itemCode",item_name AS "itemName",brand,model,status FROM lost_items WHERE (NULLIF(upper(regexp_replace(imei_1,'[^A-Za-z0-9]','','g')),'')=ANY($1::text[]) OR NULLIF(upper(regexp_replace(imei_2,'[^A-Za-z0-9]','','g')),'')=ANY($1::text[]) OR NULLIF(upper(regexp_replace(serial_number,'[^A-Za-z0-9]','','g')),'')=ANY($1::text[])) ORDER BY created_at DESC LIMIT 10`,[normalized.map(v=>v.toUpperCase().replace(/[^A-Za-z0-9]/g,''))]);
    const normalizedIds=normalized.map(v=>v.toUpperCase().replace(/[^A-Za-z0-9]/g,''));
    const declaredDuplicates=await this.db.pool.query(`SELECT declaration_ref AS "itemCode",phone_make_model AS "itemName",NULL::text AS brand,NULL::text AS model,'second-hand declaration' AS status FROM second_hand_phone_declarations WHERE (NULLIF(upper(regexp_replace(imei1,'[^A-Za-z0-9]','','g')),'')=ANY($1::text[]) OR NULLIF(upper(regexp_replace(imei2,'[^A-Za-z0-9]','','g')),'')=ANY($1::text[]) OR NULLIF(upper(regexp_replace(serial_number,'[^A-Za-z0-9]','','g')),'')=ANY($1::text[])) ORDER BY created_at DESC LIMIT 10`,[normalizedIds]);
    const duplicateMatches=[...duplicate.rows,...declaredDuplicates.rows].slice(0,10);
    const code='AUR-LI-'+Date.now().toString(36).toUpperCase()+'-'+Math.random().toString(36).slice(2,6).toUpperCase();
    const publicCode=randomUUID();
    const {rows}=await this.db.pool.query(`INSERT INTO lost_items(tenant_id,store_id,registered_by,item_code,public_code,item_name,brand,model,colour,description,imei_1,imei_2,serial_number,photo_data,purchase_date,receipt_reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::date,$16) RETURNING id,item_code AS "itemCode",item_name AS "itemName",brand,model,colour,description,imei_1 AS "imei1",imei_2 AS "imei2",serial_number AS "serialNumber",status,created_at AS "createdAt"`,[t,s,req.user.sub,code,publicCode,b.itemName.trim(),b.brand?.trim()||null,b.model?.trim()||null,b.colour?.trim()||null,b.description?.trim()||null,imei1||null,imei2||null,serial||null,null,b.purchaseDate||null,b.receiptReference?.trim()||null]);
    const base=(process.env.FRONTEND_URL||'https://swass-web.onrender.com').replace(/\/$/,'');
    const publicUrl=base+'/?lostItem='+encodeURIComponent(publicCode);
    const qrDataUrl=await QRCode.toDataURL(publicUrl,{errorCorrectionLevel:'M',margin:2,width:420});
    return {item:rows[0],publicUrl,qrDataUrl,duplicates:duplicateMatches,message:duplicateMatches.length?'Registered, but a matching identifier already exists. Review the possible duplicate before proceeding.':'Item registered successfully.'};
  }
  @Get(':id/reports') @Roles('owner','manager')
  async reports(@Req() req:any,@Param('id') id:string){
    const [t,s]=this.scope(req.user);
    const {rows}=await this.db.pool.query(`SELECT r.id,r.reporter_name AS "reporterName",r.reporter_phone AS "reporterPhone",r.report_details AS details,r.latitude,r.longitude,r.accuracy_m AS accuracy,r.location_label AS "locationLabel",r.created_at AS "createdAt" FROM lost_item_reports r JOIN lost_items li ON li.id=r.lost_item_id WHERE li.id=$1 AND li.tenant_id=$2 AND li.store_id=$3 ORDER BY r.created_at DESC LIMIT 100`,[id,t,s]);
    return {reports:rows};
  }
  @Patch(':id/status') @Roles('owner','manager')
  async updateStatus(@Req() req:any,@Param('id') id:string,@Body() b:any){
    const [t,s]=this.scope(req.user);const status=String(b?.status||'');
    if(!['registered','lost','found','recovered','closed'].includes(status))throw new BadRequestException('Choose a valid item status');
    const {rows}=await this.db.pool.query(`UPDATE lost_items SET status=$4,lost_at=CASE WHEN $4='lost' THEN COALESCE(lost_at,now()) ELSE lost_at END,recovered_at=CASE WHEN $4='recovered' THEN now() ELSE recovered_at END,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND store_id=$3 RETURNING id,status`,[id,t,s,status]);
    if(!rows[0])throw new BadRequestException('Item not found');return {item:rows[0]};
  }
}

@Controller('api/v1/public/lost-items')
export class PublicLostItemsController {
  constructor(private db:DbService){}
  @Get(':code')
  async view(@Param('code') code:string){
    if(!/^[0-9a-f-]{36}$/i.test(code))throw new BadRequestException('This AURORA item QR code is not recognised');
    const {rows}=await this.db.pool.query(`SELECT item_code AS "itemCode",item_name AS "itemName",brand,model,colour,description,status FROM lost_items WHERE public_code=$1 LIMIT 1`,[code]);
    if(!rows[0])throw new BadRequestException('This AURORA item QR code is not recognised');
    return {item:rows[0]};
  }
  @Post(':code/found')
  async report(@Param('code') code:string,@Body() b:any){
    if(!/^[0-9a-f-]{36}$/i.test(code))throw new BadRequestException('This AURORA item QR code is not recognised');
    const {rows}=await this.db.pool.query('SELECT id,status FROM lost_items WHERE public_code=$1 LIMIT 1',[code]);
    if(!rows[0])throw new BadRequestException('This AURORA item QR code is not recognised');
    if(typeof b?.reporterPhone!=='string'||b.reporterPhone.trim().length<7)throw new BadRequestException('Enter a contact phone number');
    const lat=Number(b.latitude),lng=Number(b.longitude);
    const validLocation=Number.isFinite(lat)&&lat>=-90&&lat<=90&&Number.isFinite(lng)&&lng>=-180&&lng<=180;
    await this.db.pool.query(`INSERT INTO lost_item_reports(lost_item_id,reporter_name,reporter_phone,report_details,latitude,longitude,accuracy_m,location_label) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[rows[0].id,String(b.reporterName||'').trim().slice(0,120)||null,b.reporterPhone.trim().slice(0,40),String(b.details||'').trim().slice(0,1000)||null,validLocation?lat:null,validLocation?lng:null,Number.isFinite(Number(b.accuracy))?Math.max(0,Math.min(100000,Number(b.accuracy))):null,String(b.locationLabel||'').trim().slice(0,200)||null]);
    await this.db.pool.query(`UPDATE lost_items SET status=CASE WHEN status IN ('lost','registered') THEN 'found' ELSE status END,updated_at=now() WHERE id=$1`,[rows[0].id]);
    return {message:'Thank you. Your report has been saved for the registered shop to review.'};
  }
}
