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
      'SELECT t.name AS business_name,t.phone AS business_phone,t.email AS business_email,s.name AS store_name,s.location AS store_location,s.receipt_header,s.receipt_footer,s.logo_data FROM tenants t JOIN stores s ON s.tenant_id=t.id WHERE t.id=$1 AND s.id=$2',
      [u.tenantId,u.storeId],
    );
    if (!q.rowCount) throw new BadRequestException('Business profile not found');
    const r=q.rows[0];
    return { profile:{businessName:r.business_name,businessPhone:r.business_phone,businessEmail:r.business_email,storeName:r.store_name,storeLocation:r.store_location,receiptHeader:r.receipt_header,receiptFooter:r.receipt_footer,logoData:r.logo_data} };
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
    const phone=clean(b.businessPhone,30,'Business phone');
    const email=clean(b.businessEmail,254,'Business email',true);
    const store=clean(b.storeName,120,'Store name');
    const location=clean(b.storeLocation,200,'Store location',true);
    const header=clean(b.receiptHeader,300,'Receipt header',true);
    const footer=clean(b.receiptFooter,300,'Receipt footer',true);
    const logo=b.logoData;
    if(email && (!email.includes('@') || !email.includes('.'))) throw new BadRequestException('Enter a valid business email');
    if(logo!==undefined && logo!==null && (typeof logo!=='string'||logo.length>90000||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(logo))) throw new BadRequestException('Upload a PNG, JPG or WebP logo smaller than 60 KB');
    await this.db.tx(async c=>{
      await c.query('UPDATE tenants SET name=COALESCE($1,name),phone=COALESCE($2,phone),email=CASE WHEN $3 THEN $4 ELSE email END WHERE id=$5',[name??null,phone??null,b.businessEmail!==undefined,email??null,u.tenantId]);
      await c.query('UPDATE stores SET name=COALESCE($1,name),location=CASE WHEN $2 THEN $3 ELSE location END,receipt_header=CASE WHEN $4 THEN $5 ELSE receipt_header END,receipt_footer=CASE WHEN $6 THEN $7 ELSE receipt_footer END,logo_data=CASE WHEN $8 THEN $9 ELSE logo_data END WHERE tenant_id=$10 AND id=$11',[store??null,b.storeLocation!==undefined,location??null,b.receiptHeader!==undefined,header??null,b.receiptFooter!==undefined,footer??null,b.logoData!==undefined,logo??null,u.tenantId,u.storeId]);
    });
    return {updated:true};
  }
}
