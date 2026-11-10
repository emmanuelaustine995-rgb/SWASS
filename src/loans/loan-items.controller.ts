import { BadRequestException, Body, Controller, Get, Patch, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';
import { EmailVerificationService } from '../notifications/email-verification.service';
import { WhatsAppReceiptService } from '../notifications/whatsapp-receipt.service';
import PDFDocument = require('pdfkit');
import { hashNationalId } from '../receipts/receipts.service';

@Controller('api/v1/loan-items')
@UseGuards(AuthGuard, RolesGuard)
export class LoanItemsController {
  constructor(private db: DbService, private email: EmailVerificationService, private whatsapp: WhatsAppReceiptService) {}
  private scope(user:any){if(!user.tenantId||!user.storeId)throw new BadRequestException('Shop details are unavailable');return [user.tenantId,user.storeId];}
  @Get() @Roles('owner')
  async list(@Req() req:any){const [t,s]=this.scope(req.user);const {rows}=await this.db.pool.query(`SELECT id,reference,item_name AS "itemName",borrower_name AS "borrowerName",phone,id_number AS "idNumber",borrower_email AS "borrowerEmail",imei,serial_number AS "serialNumber",loan_date AS "loanDate",condition_out AS "conditionOut",condition_in AS "conditionIn",amount_kes AS "amountKes",processed_by AS "processedBy",returned,sold,created_at AS "createdAt" FROM loan_items WHERE tenant_id=$1 AND store_id=$2 ORDER BY created_at DESC LIMIT 100`,[t,s]);return {items:rows};}
  @Post() @Roles('owner')
  async create(@Req() req:any,@Body() b:any){
    const [t,s]=this.scope(req.user);
    const required=['itemName','borrowerName','phone','idNumber','loanDate','conditionOut','borrowerEmail'];
    for(const k of required)if(typeof b?.[k]!=='string'||!b[k].trim())throw new BadRequestException(k+' is required');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.borrowerEmail))throw new BadRequestException('Enter a valid borrower email address');
    const amount=Number(b.amountKes);if(!Number.isSafeInteger(amount)||amount<0||amount>100000000)throw new BadRequestException('Enter a valid deposit / value amount');
    const nationalIdHash=hashNationalId(b.idNumber.trim());
    const ref='AUR-LN-'+Date.now().toString(36).toUpperCase();
    const {rows}=await this.db.pool.query(`INSERT INTO loan_items(tenant_id,store_id,reference,item_name,borrower_name,phone,id_number,national_id_hash,borrower_email,imei,serial_number,loan_date,condition_out,amount_kes,processed_by,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::date,$13,$14,$15,$16) RETURNING id`,[t,s,ref,b.itemName.trim(),b.borrowerName.trim(),b.phone.trim(),b.idNumber.trim(),nationalIdHash,b.borrowerEmail.trim().toLowerCase(),b.imei?.trim()||null,b.serialNumber?.trim()||null,b.loanDate,b.conditionOut.trim(),amount,b.processedBy?.trim()||req.user.fullName||'Shop owner',req.user.sub]);
    const record={...b,reference:ref,processedBy:b.processedBy||req.user.fullName||'Shop owner',createdAt:new Date().toISOString()};
    const business=await this.db.pool.query('SELECT t.name,t.phone,t.email,s.name AS store_name,s.location,s.logo_data,s.receipt_header,s.receipt_footer FROM tenants t JOIN stores s ON s.tenant_id=t.id AND s.id=$2 WHERE t.id=$1',[t,s]);
    const shop=business.rows[0]||{};
    const pdf=await this.makePdf(record,shop);
    const owner=await this.db.pool.query('SELECT email,phone,full_name FROM users WHERE id=$1 AND tenant_id=$2',[req.user.sub,t]);
    const ownerRow=owner.rows[0]||{};
    const deliver=async(fn:()=>Promise<any>)=>{try{const x=await fn();return {sent:!!x?.sent};}catch(e){return {sent:false,reason:e instanceof Error?e.message:'Delivery failed'};}};
    const [emailDelivery,whatsappDelivery,customerEmailDelivery,customerWhatsappDelivery]=await Promise.all([
      ownerRow.email?deliver(()=>this.email.sendLoanNote({to:ownerRow.email,ownerName:ownerRow.full_name||'Shop owner',businessName:shop.name||'AURORA',reference:ref,itemName:b.itemName,borrowerName:b.borrowerName,pdf})):Promise.resolve({sent:false,reason:'Owner email is not registered'}),
      ownerRow.phone?deliver(()=>this.whatsapp.sendPdf({to:ownerRow.phone,receiptNo:ref,businessName:shop.name||'AURORA',pdf})):Promise.resolve({sent:false,reason:'Owner phone is not registered'}),
      deliver(()=>this.email.sendLoanNote({to:b.borrowerEmail,ownerName:b.borrowerName,businessName:shop.name||'AURORA',reference:ref,itemName:b.itemName,borrowerName:b.borrowerName,pdf})),
      deliver(()=>this.whatsapp.sendPdf({to:b.phone,receiptNo:ref,businessName:shop.name||'AURORA',pdf}))
    ]);
    return {item:{id:rows[0].id,...record},pdfBase64:pdf.toString('base64'),ownerDelivery:{email:emailDelivery,whatsapp:whatsappDelivery},customerDelivery:{email:customerEmailDelivery,whatsapp:customerWhatsappDelivery},message:'Loan record saved. Customer and owner delivery attempts completed.'};
  }
  @Patch(':id/status') @Roles('owner')
  async status(@Req() req:any,@Param('id') id:string,@Body() b:any){const [t,s]=this.scope(req.user);if(!b||(!['returned','sold'].includes(b.status)))throw new BadRequestException('Choose Returned or Sold');const col=b.status==='returned'?'returned':'sold';const condition=typeof b.conditionIn==='string'?b.conditionIn.trim():null;const {rows}=await this.db.pool.query(`UPDATE loan_items SET ${col}=true,condition_in=COALESCE($4,condition_in),updated_at=now() WHERE id=$1 AND tenant_id=$2 AND store_id=$3 RETURNING id,${col} AS status`,[id,t,s,condition]);if(!rows[0])throw new BadRequestException('Loan item not found');return {item:rows[0]};}
  private async makePdf(x:any,shop:any):Promise<Buffer>{return new Promise((resolve,reject)=>{
    const d=new PDFDocument({size:'A4',margin:42,info:{Title:'AURORA Item on Loan '+x.reference,Author:shop.name||'AURORA E-RECEIPT'}});
    const chunks:Buffer[]=[];d.on('data',(v:Buffer)=>chunks.push(v));d.on('end',()=>resolve(Buffer.concat(chunks)));d.on('error',reject);
    const navy='#123B63',blue='#1769AA',ink='#263445',muted='#667789',line='#D9E2EC';
    const money=Number(x.amountKes||0).toLocaleString('en-KE',{minimumFractionDigits:2,maximumFractionDigits:2});
    let y=42;
    d.roundedRect(42,y,511,104,12).fill('#F1F6FB');
    if(shop.logo_data){try{const raw=String(shop.logo_data).replace(/^data:image\\/[a-zA-Z0-9.+-]+;base64,/,'');d.image(Buffer.from(raw,'base64'),56,y+17,{fit:[86,66]});}catch{}}
    const tx=shop.logo_data?154:58;
    d.fillColor(navy).font('Helvetica-Bold').fontSize(19).text(shop.name||'AURORA E-RECEIPT',tx,y+17,{width:385});
    d.fillColor(muted).font('Helvetica').fontSize(9).text(shop.store_name||'Shop',tx,y+43,{width:385});
    d.text([shop.location,shop.phone,shop.email].filter(Boolean).join('  |  '),tx,y+59,{width:385});
    d.moveTo(42,y+116).lineTo(553,y+116).strokeColor(line).stroke();
    y+=132;
    d.fillColor(blue).font('Helvetica-Bold').fontSize(17).text('GOODS ON LOAN',42,y,{align:'center'});
    d.fillColor(muted).font('Helvetica').fontSize(9).text('OFFICIAL LOAN NOTE · CUSTOMER / SHOP COPY',42,y+25,{align:'center'});
    y+=57;
    d.roundedRect(42,y,511,43,7).fill('#EAF2FA');
    d.fillColor(navy).font('Helvetica-Bold').fontSize(10).text('LOAN REFERENCE',55,y+9);
    d.fontSize(12).text(x.reference,55,y+22);
    d.fillColor(muted).font('Helvetica').fontSize(9).text('DATE ISSUED',385,y+9);
    d.fillColor(ink).font('Helvetica-Bold').fontSize(10).text(String(x.loanDate||new Date().toISOString().slice(0,10)),385,y+22);
    y+=60;
    const section=(title:string)=>{d.fillColor(navy).font('Helvetica-Bold').fontSize(10).text(title.toUpperCase(),42,y);y+=17;d.moveTo(42,y).lineTo(553,y).strokeColor(line).stroke();y+=8;};
    const field=(label:string,value:any)=>{d.fillColor(muted).font('Helvetica').fontSize(8).text(label.toUpperCase(),52,y);d.fillColor(ink).font('Helvetica-Bold').fontSize(10).text(String(value??'—')||'—',52,y+11,{width:480});y+=34;};
    section('Borrower details');
    field('Customer / borrower',x.borrowerName);field('Phone number',x.phone);field('National ID / Passport',x.idNumber);field('Email address',x.borrowerEmail);
    section('Item details');
    field('Goods / item name',x.itemName);
    const half=(label:string,value:any,left:number)=>{d.fillColor(muted).font('Helvetica').fontSize(8).text(label.toUpperCase(),left,y);d.fillColor(ink).font('Helvetica-Bold').fontSize(10).text(String(value??'—')||'—',left,y+11,{width:225});};
    half('IMEI',x.imei,52);half('Serial number',x.serialNumber,310);y+=34;
    field('Condition at handover',x.conditionOut);
    half('Deposit / declared value (KSh)',money,52);half('Processed by',x.processedBy,310);y+=42;
    d.roundedRect(42,y,511,48,7).lineWidth(1).strokeColor(line).stroke();
    d.fillColor(navy).font('Helvetica-Bold').fontSize(9).text('RETURN / SALE STATUS',54,y+9);
    d.fillColor(ink).font('Helvetica').fontSize(9).text('Returned:  NO                         Sold:  NO',54,y+25);
    y+=66;
    d.fillColor(ink).font('Helvetica').fontSize(9).text('I acknowledge receipt of the item described above in the stated condition and agree to return it or settle the matter with the issuing shop.',42,y,{width:511,align:'justify',lineGap:3});
    y+=55;
    d.moveTo(52,y+24).lineTo(245,y+24).strokeColor('#718096').stroke();d.moveTo(350,y+24).lineTo(543,y+24).strokeColor('#718096').stroke();
    d.fillColor(muted).fontSize(8).text('Borrower signature / thumbprint',52,y+29);d.text('Shop representative signature',350,y+29);
    y+=62;
    if(shop.receipt_footer){d.fillColor(muted).font('Helvetica').fontSize(8).text(shop.receipt_footer,42,y,{align:'center',width:511});y+=18;}
    d.moveTo(42,760).lineTo(553,760).strokeColor(line).stroke();
    d.fillColor(muted).fontSize(8).text((shop.receipt_header||'AURORA E-RECEIPT')+'  ·  Keep this document for your records',42,770,{align:'center',width:511});
    d.end();
  });}
}
