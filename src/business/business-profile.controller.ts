import { BadRequestException, Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';

@Controller('api/v1/business/profile')
@UseGuards(AuthGuard, RolesGuard)
export class BusinessProfileController {
  constructor(private db: DbService) {}

  @Get()
  @Roles('owner', 'manager')
  async getProfile(@Req() req: any) {
    const u = req.user;
    if (!u?.tenantId || !u?.storeId) throw new BadRequestException('Business account required');
    const q = await this.db.pool.query(
      'SELECT t.name AS business_name,t.phone AS business_phone,t.email AS business_email,s.name AS store_name,s.location AS store_location,s.receipt_header,s.receipt_footer,s.logo_data,t.legal_name,t.website_url,t.kra_pin,t.registration_code,s.house_name,s.floor,s.house_number,s.outlet_id,s.terminal_number FROM tenants t JOIN stores s ON s.tenant_id=t.id WHERE t.id=$1 AND s.id=$2',
      [u.tenantId,u.storeId],
    );
    if (!q.rowCount) throw new BadRequestException('Business profile not found');
    const r=q.rows[0];
    return { profile:{businessName:r.business_name,businessPhone:r.business_phone,businessEmail:r.business_email,storeName:r.store_name,storeLocation:r.store_location,receiptHeader:r.receipt_header,receiptFooter:r.receipt_footer,logoData:r.logo_data,legalName:r.legal_name,websiteUrl:r.website_url,kraPin:r.kra_pin,registrationCode:r.registration_code,houseName:r.house_name,floor:r.floor,houseNumber:r.house_number,outletId:r.outlet_id,terminalNumber:r.terminal_number} };
  }

  @Patch()
  @Roles('owner')
  async updateProfile(@Req() req:any,@Body() b:any) {
    const u=req.user;
    if (!u?.tenantId || !u?.storeId) throw new BadRequestException('Business account required');
    const clean=(v:any,max:number,label:string,nullable=false) => {
      if(v===undefined)return undefined;
      if(v===null&&nullable)return null;
      if(typeof v!=='string')throw new BadRequestException(label+' must be text');
      const x=v.trim();
      if(!x&&nullable)return null;
      if(!x||x.length>max)throw new BadRequestException(label+' is required and must be at most '+max+' characters');
      return x;
    };
    const name=clean(b.businessName,120,'Business name');
    const legal=clean(b.legalName,160,'Legal entity name',true);
    const website=clean(b.websiteUrl,255,'Website URL',true);
    const kra=clean(b.kraPin,40,'KRA PIN',true);
    const registration=clean(b.registrationCode,80,'Business registration code',true);
    const house=clean(b.houseName,120,'House name',true);
    const floor=clean(b.floor,40,'Floor',true);
    const houseNumber=clean(b.houseNumber,40,'House number',true);
    const outlet=clean(b.outletId,80,'Outlet ID',true);
    const terminal=clean(b.terminalNumber,80,'POS terminal number',true);
    if(website && !/^https?:\/\//i.test(website)) throw new BadRequestException('Website URL must start with http:// or https://');
    const phone=clean(b.businessPhone,30,'Business phone');
    const email=clean(b.businessEmail,254,'Business email',true);
    const store=clean(b.storeName,120,'Store name');
    const location=clean(b.storeLocation,200,'Store location',true);
    const header=clean(b.receiptHeader,300,'Receipt header',true);
    const footer=clean(b.receiptFooter,300,'Receipt footer',true);
    const logo=b.logoData;
    if(email && (!email.includes('@') || !email.includes('.'))) throw new BadRequestException('Enter a valid business email');
    if(logo!==undefined && logo!==null && (typeof logo!=='string'||logo.length>90000||!new RegExp('^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$').test(logo))) throw new BadRequestException('Upload a PNG, JPG or WebP logo smaller than 60 KB');
    await this.db.tx(async c=>{
      await c.query('UPDATE tenants SET name=COALESCE($1,name),phone=COALESCE($2,phone),email=CASE WHEN $3 THEN $4 ELSE email END,legal_name=CASE WHEN $5 THEN $6 ELSE legal_name END,website_url=CASE WHEN $7 THEN $8 ELSE website_url END,kra_pin=CASE WHEN $9 THEN $10 ELSE kra_pin END,registration_code=CASE WHEN $11 THEN $12 ELSE registration_code END WHERE id=$13',[name??null,phone??null,b.businessEmail!==undefined,email??null,b.legalName!==undefined,legal??null,b.websiteUrl!==undefined,website??null,b.kraPin!==undefined,kra??null,b.registrationCode!==undefined,registration??null,u.tenantId]);
      await c.query('UPDATE stores SET name=COALESCE($1,name),location=CASE WHEN $2 THEN $3 ELSE location END,receipt_header=CASE WHEN $4 THEN $5 ELSE receipt_header END,receipt_footer=CASE WHEN $6 THEN $7 ELSE receipt_footer END,logo_data=CASE WHEN $8 THEN $9 ELSE logo_data END,house_name=CASE WHEN $10 THEN $11 ELSE house_name END,floor=CASE WHEN $12 THEN $13 ELSE floor END,house_number=CASE WHEN $14 THEN $15 ELSE house_number END,outlet_id=CASE WHEN $16 THEN $17 ELSE outlet_id END,terminal_number=CASE WHEN $18 THEN $19 ELSE terminal_number END WHERE tenant_id=$20 AND id=$21',[store??null,b.storeLocation!==undefined,location??null,b.receiptHeader!==undefined,header??null,b.receiptFooter!==undefined,footer??null,b.logoData!==undefined,logo??null,b.houseName!==undefined,house??null,b.floor!==undefined,floor??null,b.houseNumber!==undefined,houseNumber??null,b.outletId!==undefined,outlet??null,b.terminalNumber!==undefined,terminal??null,u.tenantId,u.storeId]);
    });
    return {updated:true};
  }
}
