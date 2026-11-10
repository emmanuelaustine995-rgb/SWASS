import { BadRequestException, Body, Controller, Get, Patch, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';
import { EmailVerificationService } from '../notifications/email-verification.service';
import { WhatsAppReceiptService } from '../notifications/whatsapp-receipt.service';
import PDFDocument = require('pdfkit');

@Controller('api/v1/loan-items')
@UseGuards(AuthGuard, RolesGuard)
export class LoanItemsController {
  constructor(private db: DbService, private email: EmailVerificationService, private whatsapp: WhatsAppReceiptService) {}
  private scope(user:any){if(!user.tenantId||!user.storeId)throw new BadRequestException('Shop details are unavailable');return [user.tenantId,user.storeId];}
  @Get() @Roles('owner')
  async list(@Req() req:any){const [t,s]=this.scope(req.user);const {rows}=await this.db.pool.query(`SELECT id,reference,item_name AS "itemName",borrower_name AS "borrowerName",phone,id_number AS "idNumber",borrower_email AS "borrowerEmail",imei,serial_number AS "serialNumber",loan_date AS "loanDate",expected_return_date AS "expectedReturnDate",condition_out AS "conditionOut",condition_in AS "conditionIn",amount_kes AS "amountKes",processed_by AS "processedBy",returned,sold,created_at AS "createdAt" FROM loan_items WHERE tenant_id=$1 AND store_id=$2 ORDER BY created_at DESC LIMIT 100`,[t,s]);return {items:rows};}
  @Post() @Roles('owner')
  async create(@Req() req:any,@Body() b:any){
    const [t,s]=this.scope(req.user);
    const required=['itemName','borrowerName','phone','idNumber','loanDate','expectedReturnDate','conditionOut','borrowerEmail'];
    for(const k of required)if(typeof b?.[k]!=='string'||!b[k].trim())throw new BadRequestException(k+' is required');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.borrowerEmail))throw new BadRequestException('Enter a valid borrower email address');
    const amount=Number(b.amountKes);if(!Number.isSafeInteger(amount)||amount<0||amount>100000000)throw new BadRequestException('Enter a valid deposit / value amount');
    const ref='AUR-LN-'+Date.now().toString(36).toUpperCase();
    const {rows}=await this.db.pool.query(`INSERT INTO loan_items(tenant_id,store_id,reference,item_name,borrower_name,phone,id_number,borrower_email,imei,serial_number,loan_date,expected_return_date,condition_out,amount_kes,processed_by,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12::date,$13,$14,$15,$16) RETURNING id`,[t,s,ref,b.itemName.trim(),b.borrowerName.trim(),b.phone.trim(),b.idNumber.trim(),b.borrowerEmail.trim().toLowerCase(),b.imei?.trim()||null,b.serialNumber?.trim()||null,b.loanDate,b.expectedReturnDate,b.conditionOut.trim(),amount,b.processedBy?.trim()||req.user.fullName||'Shop owner',req.user.sub]);
    const record={...b,reference:ref,processedBy:b.processedBy||req.user.fullName||'Shop owner',createdAt:new Date().toISOString()};
    const pdf=await this.makePdf(record);
    const business=await this.db.pool.query('SELECT name,phone,email FROM tenants WHERE id=$1',[t]);
    const shop=business.rows[0]||{};
    const owner=await this.db.pool.query('SELECT email,phone,full_name FROM users WHERE id=$1 AND tenant_id=$2',[req.user.sub,t]);
    const ownerRow=owner.rows[0]||{};
    const deliver=async(fn:()=>Promise<any>)=>{try{const x=await fn();return {sent:!!x?.sent};}catch(e){return {sent:false,reason:e instanceof Error?e.message:'Delivery failed'};}};
    const [emailDelivery,whatsappDelivery,customerEmailDelivery,customerWhatsappDelivery]=await Promise.all([
      ownerRow.email?deliver(()=>this.email.sendLoanNote({to:ownerRow.email,ownerName:ownerRow.full_name||'Shop owner',businessName:shop.name||'AURORA',reference:ref,itemName:b.itemName,borrowerName:b.borrowerName,pdf})):Promise.resolve({sent:false,reason:'Owner email is not registered'}),
      ownerRow.phone?deliver(()=>this.whatsapp.sendPdf({to:ownerRow.phone,receiptNo:ref,businessName:shop.name||'AURORA',pdf})):Promise.resolve({sent:false,reason:'Owner phone is not registered'})
    ]);
    return {item:{id:rows[0].id,...record},pdfBase64:pdf.toString('base64'),ownerDelivery:{email:emailDelivery,whatsapp:whatsappDelivery},message:'Loan record saved. Owner delivery attempts completed.'};
  }
  @Patch(':id/status') @Roles('owner')
  async status(@Req() req:any,@Param('id') id:string,@Body() b:any){const [t,s]=this.scope(req.user);if(!b||(!['returned','sold'].includes(b.status)))throw new BadRequestException('Choose Returned or Sold');const col=b.status==='returned'?'returned':'sold';const condition=typeof b.conditionIn==='string'?b.conditionIn.trim():null;const {rows}=await this.db.pool.query(`UPDATE loan_items SET ${col}=true,condition_in=COALESCE($4,condition_in),updated_at=now() WHERE id=$1 AND tenant_id=$2 AND store_id=$3 RETURNING id,${col} AS status`,[id,t,s,condition]);if(!rows[0])throw new BadRequestException('Loan item not found');return {item:rows[0]};}
  private async makePdf(x:any):Promise<Buffer>{return new Promise((resolve,reject)=>{const d=new PDFDocument({size:'A4',margin:48});const chunks:Buffer[]=[];d.on('data',(c:Buffer)=>chunks.push(c));d.on('end',()=>resolve(Buffer.concat(chunks)));d.on('error',reject);d.fontSize(20).fillColor('#80643b').text('AURORA E-RECEIPT',{align:'center'});d.moveDown(.4);d.fontSize(16).fillColor('#493d2b').text('ITEM ON LOAN · CUSTOMER / OWNER COPY',{align:'center'});d.moveDown();d.fontSize(10).fillColor('#222');d.text('Loan reference: '+x.reference);d.text('Date out: '+x.loanDate);d.text('Expected return: '+x.expectedReturnDate);d.moveDown();for(const [label,key] of [['Item name','itemName'],['Borrower / customer','borrowerName'],['Phone number','phone'],['ID / Passport number','idNumber'],['IMEI number','imei'],['Serial number','serialNumber'],['Condition out','conditionOut'],['Deposit / value (KSh)','amountKes'],['Processed by','processedBy']])d.text(label+': '+(x[key]??'—'));d.moveDown();d.text('Returned: No');d.text('Sold: No');d.moveDown();d.text('Borrower acknowledgement: ______________________________');d.moveDown();d.text('Shop representative: ____________________________________');d.moveDown();d.fontSize(8).fillColor('#777').text('Keep this note as a record of the item issued on loan.');d.end();});}
}
