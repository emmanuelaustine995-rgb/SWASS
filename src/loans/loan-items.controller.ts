import { BadRequestException, Body, Controller, Get, Patch, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';
import { EmailVerificationService } from '../notifications/email-verification.service';
import { WhatsAppReceiptService } from '../notifications/whatsapp-receipt.service';
import PDFDocument = require('pdfkit');
import { hashNationalId } from '../receipts/receipts.service';

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

@Controller('api/v1/loan-items')
@UseGuards(AuthGuard, RolesGuard)
export class LoanItemsController {
  constructor(private db: DbService, private email: EmailVerificationService, private whatsapp: WhatsAppReceiptService) {}
  private scope(user:any){if(!user.tenantId||!user.storeId)throw new BadRequestException('Shop details are unavailable');return [user.tenantId,user.storeId];}
  private partyRole(user:any):'owner'|'freelancer'|'customer' {
    if(user?.role==='customer')return 'customer';
    if(user?.role==='freelancer'||user?.role==='vendor')return 'freelancer';
    if(user?.role==='owner')return 'owner';
    throw new BadRequestException('This account cannot create or manage loans');
  }
  private async partyDetails(role:'owner'|'freelancer'|'customer',id:string){
    if(role==='customer'){
      const q=await this.db.pool.query('SELECT id,full_name AS name,phone FROM customer_accounts WHERE id=$1 AND is_active=true',[id]);
      return q.rows[0]||null;
    }
    const q=await this.db.pool.query("SELECT id,full_name AS name,phone,tenant_id AS \"tenantId\",store_id AS \"storeId\" FROM users WHERE id=$1 AND is_active=true AND role=ANY($2::text[])",[id,role==='freelancer'?['freelancer','vendor']:['owner']]);
    return q.rows[0]||null;
  }
  private async findPartyByPhone(phone:string){
    const rawDigits=String(phone||'').replace(/[^0-9]/g,'');
    const digits=rawDigits.startsWith('254')?rawDigits:rawDigits.startsWith('0')?'254'+rawDigits.slice(1):rawDigits.length===9?'254'+rawDigits:rawDigits;
    if(digits.length!==12)throw new BadRequestException('Enter a valid Kenyan borrower phone number');
    const q=await this.db.pool.query(
      `SELECT id,role,full_name AS name,phone FROM users
        WHERE is_active=true AND role IN ('owner','freelancer','vendor')
          AND regexp_replace(phone,'[^0-9]','','g') IN ($1, '0'||right($1,9), right($1,9))
       UNION ALL
       SELECT id,'customer' AS role,full_name AS name,phone FROM customer_accounts
        WHERE is_active=true AND regexp_replace(phone,'[^0-9]','','g') IN ($1, '0'||right($1,9), right($1,9))
      `,
      [digits],
    );
    if(q.rows.length===0)throw new BadRequestException('No active AURORA account was found for that phone number');
    if(q.rows.length>1)throw new BadRequestException('More than one account uses that phone number. Contact the recipient to confirm their registered account.');
    const row=q.rows[0];
    const role=row.role==='vendor'?'freelancer':row.role;
    return {id:row.id,role,name:row.name,phone:row.phone};
  }
  private async activity(loanId:string,actorRole:string,actorId:string|null,eventType:string,details:any={}){
    await this.db.pool.query(
      'INSERT INTO aurora_loan_activity(loan_id,actor_role,actor_id,event_type,details) VALUES($1,$2,$3,$4,$5::jsonb)',
      [loanId,actorRole,actorId,eventType,JSON.stringify(details)],
    );
  }

  // Shared account workspace: every supported party sees both loans they
  // issued and offers/items they received, without exposing other accounts.
  @Get('workspace') @Roles('owner','freelancer','customer')
  async workspace(@Req() req:any){
    const role=this.partyRole(req.user),id=req.user.sub;
    const [{rows},summary]=await Promise.all([
      this.db.pool.query(
        `SELECT l.*,
          (l.status IN ('active','sale_pending','return_pending') AND l.expected_return_date<CURRENT_DATE) AS overdue,
          CASE WHEN l.accepted_at IS NULL THEN 0 ELSE GREATEST(1,CURRENT_DATE-l.accepted_at::date+1) END AS "daysOnLoan",
          (l.lender_role=$1 AND l.lender_id=$2) AS "isLender"
         FROM aurora_loans l
         WHERE (l.lender_role=$1 AND l.lender_id=$2)
            OR (l.borrower_role=$1 AND l.borrower_id=$2)
         ORDER BY l.created_at DESC LIMIT 200`,
        [role,id],
      ),
      this.db.pool.query(
        `SELECT COUNT(*) FILTER (WHERE lender_role=$1 AND lender_id=$2)::int AS "lentCount",
                COUNT(*) FILTER (WHERE borrower_role=$1 AND borrower_id=$2)::int AS "borrowedCount"
           FROM aurora_loans
          WHERE (lender_role=$1 AND lender_id=$2) OR (borrower_role=$1 AND borrower_id=$2)`,
        [role,id],
      ),
    ]);
    return {loans:rows,summary:summary.rows[0]||{lentCount:0,borrowedCount:0}};
  }

  @Post('offers') @Roles('owner','freelancer','customer')
  async createOffer(@Req() req:any,@Body() b:any){
    const role=this.partyRole(req.user),lender=await this.partyDetails(role,req.user.sub);
    if(!lender)throw new BadRequestException('Your active account could not be verified');
    if(b?.ownershipConfirmed!==true)throw new BadRequestException('Confirm that you own or are authorised to lend this item');
    const itemName=String(b?.itemName||'').trim();
    const borrowerPhone=String(b?.borrowerPhone||'').trim();
    const conditionOut=String(b?.conditionOut||'').trim();
    const due=String(b?.expectedReturnDate||'').trim();
    const quantity=Number(b?.quantity||1),value=Number(b?.valueKes||0);
    if(!itemName||itemName.length>160)throw new BadRequestException('Enter a valid item name');
    if(!conditionOut||conditionOut.length>1000)throw new BadRequestException('Describe the item condition');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(due)||Number.isNaN(Date.parse(due))||due<new Date().toISOString().slice(0,10))throw new BadRequestException('Choose a valid return date');
    if(!Number.isSafeInteger(quantity)||quantity<1||quantity>10000)throw new BadRequestException('Enter a valid quantity');
    if(!Number.isSafeInteger(value)||value<0||value>1000000000)throw new BadRequestException('Enter a valid item value');
    for(const [label,value] of [['IMEI',String(b?.imei||'').trim()],['serial number',String(b?.serialNumber||'').trim()]] as const)if(value&&!/^[A-Za-z0-9 ._/-]{6,80}$/.test(value))throw new BadRequestException('Enter a valid '+label+' (6–80 letters or numbers)');
    const borrower=await this.findPartyByPhone(borrowerPhone);
    if(borrower.role===role&&borrower.id===req.user.sub)throw new BadRequestException('You cannot lend an item to your own account');
    const reference='AUR-LN-'+Date.now().toString(36).toUpperCase()+'-'+Math.random().toString(36).slice(2,6).toUpperCase();
    const params=[reference,role,req.user.sub,lender.name,lender.phone,lender.tenantId||null,lender.storeId||null,borrower.role,borrower.id,borrower.name,borrower.phone,itemName,quantity,value,String(b?.imei||'').trim()||null,String(b?.serialNumber||'').trim()||null,conditionOut,due,b?.sellingAllowed===true];
    try{
      const q=await this.db.pool.query(
        `INSERT INTO aurora_loans(reference,lender_role,lender_id,lender_name,lender_phone,lender_tenant_id,lender_store_id,borrower_role,borrower_id,borrower_name,borrower_phone,item_name,quantity,value_kes,imei,serial_number,condition_out,expected_return_date,selling_allowed,lender_authorised)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::date,$19,true)
         RETURNING id,reference,status,created_at AS "createdAt",expected_return_date AS "expectedReturnDate"`,
        params,
      );
      await this.activity(q.rows[0].id,role,req.user.sub,'offer_created',{borrowerRole:borrower.role,borrowerName:borrower.name,itemName,quantity,sellingAllowed:b?.sellingAllowed===true});
      return {loan:q.rows[0],message:'Loan offer sent. The recipient must accept it before the loan period starts.'};
    }catch(error:any){
      if(error?.code==='23505')throw new BadRequestException('This IMEI or serial number is already part of an open loan');
      throw error;
    }
  }

  @Patch(':id/accept') @Roles('owner','freelancer','customer')
  async acceptOffer(@Req() req:any,@Param('id') id:string){
    const role=this.partyRole(req.user);
    const q=await this.db.pool.query(
      `UPDATE aurora_loans SET status='active',accepted_at=now(),updated_at=now()
       WHERE id=$1 AND borrower_role=$2 AND borrower_id=$3 AND status='offered'
       RETURNING id,reference,status,accepted_at AS "acceptedAt",expected_return_date AS "expectedReturnDate"`,
      [id,role,req.user.sub],
    );
    if(!q.rows[0])throw new BadRequestException('Offer not found, already handled, or not addressed to your account');
    await this.activity(id,role,req.user.sub,'offer_accepted',{});
    return {loan:q.rows[0],message:'Item accepted. Your loan-day counter has started.'};
  }

  @Patch(':id/decline') @Roles('owner','freelancer','customer')
  async declineOffer(@Req() req:any,@Param('id') id:string,@Body() b:any){
    const role=this.partyRole(req.user),reason=String(b?.reason||'').trim().slice(0,500);
    const q=await this.db.pool.query(
      `UPDATE aurora_loans SET status='declined',closed_at=now(),updated_at=now(),last_decision_reason=$4
       WHERE id=$1 AND borrower_role=$2 AND borrower_id=$3 AND status='offered'
       RETURNING id,reference,status`,
      [id,role,req.user.sub,reason||'Offer declined by recipient'],
    );
    if(!q.rows[0])throw new BadRequestException('Offer not found or already handled');
    await this.activity(id,role,req.user.sub,'offer_declined',{reason});
    return {loan:q.rows[0]};
  }

  @Post(':id/sale-report') @Roles('owner','freelancer','customer')
  async reportSale(@Req() req:any,@Param('id') id:string,@Body() b:any){
    const role=this.partyRole(req.user);
    const salePrice=Number(b?.salePriceKes),saleDate=String(b?.saleDate||'').trim();
    if(!Number.isSafeInteger(salePrice)||salePrice<0||salePrice>1000000000)throw new BadRequestException('Enter a valid sale price');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(saleDate))throw new BadRequestException('Enter the sale date');
    const report={salePriceKes:salePrice,saleDate,buyerName:String(b?.buyerName||'').trim().slice(0,160),receiptReference:String(b?.receiptReference||'').trim().slice(0,120),notes:String(b?.notes||'').trim().slice(0,1000)};
    const q=await this.db.pool.query(
      `UPDATE aurora_loans SET status='sale_pending',sale_report=$4::jsonb,updated_at=now()
       WHERE id=$1 AND borrower_role=$2 AND borrower_id=$3 AND status='active' AND selling_allowed=true
       RETURNING id,reference,status`,
      [id,role,req.user.sub,JSON.stringify(report)],
    );
    if(!q.rows[0])throw new BadRequestException('Selling is not permitted for this loan, or the loan is not active');
    await this.activity(id,role,req.user.sub,'sale_reported',report);
    return {loan:q.rows[0],message:'Sale report sent to the lender for approval. Ownership has not transferred.'};
  }

  @Post(':id/return-request') @Roles('owner','freelancer','customer')
  async requestReturn(@Req() req:any,@Param('id') id:string,@Body() b:any){
    const role=this.partyRole(req.user),conditionIn=String(b?.conditionIn||'').trim();
    if(!conditionIn||conditionIn.length>1000)throw new BadRequestException('Describe the item condition before requesting its return');
    const report={conditionIn,notes:String(b?.notes||'').trim().slice(0,1000)};
    const q=await this.db.pool.query(
      `UPDATE aurora_loans SET status='return_pending',return_report=$4::jsonb,updated_at=now()
       WHERE id=$1 AND borrower_role=$2 AND borrower_id=$3 AND status='active'
       RETURNING id,reference,status`,
      [id,role,req.user.sub,JSON.stringify(report)],
    );
    if(!q.rows[0])throw new BadRequestException('This loan is not active or does not belong to your account');
    await this.activity(id,role,req.user.sub,'return_requested',report);
    return {loan:q.rows[0],message:'Return request sent. The lender must confirm physical receipt.'};
  }

  @Patch(':id/decision') @Roles('owner','freelancer','customer')
  async decideRequest(@Req() req:any,@Param('id') id:string,@Body() b:any){
    const role=this.partyRole(req.user),action=String(b?.action||''),reason=String(b?.reason||'').trim().slice(0,500);
    let nextStatus:string,expected:string,event:string;
    if(action==='approve_sale'){nextStatus='sold';expected='sale_pending';event='sale_approved';}
    else if(action==='approve_return'){nextStatus='returned';expected='return_pending';event='return_approved';}
    else if(action==='reject'){nextStatus='active';expected=['sale_pending','return_pending'] as any;event='request_rejected';if(!reason)throw new BadRequestException('Give a reason for rejecting the request');}
    else throw new BadRequestException('Choose approve_sale, approve_return or reject');
    const q=action==='reject'
      ? await this.db.pool.query(`UPDATE aurora_loans SET status='active',last_decision_reason=$4,updated_at=now()
          WHERE id=$1 AND lender_role=$2 AND lender_id=$3 AND status IN ('sale_pending','return_pending') RETURNING id,reference,status`,[id,role,req.user.sub,reason])
      : await this.db.pool.query(`UPDATE aurora_loans SET status=$4,closed_at=now(),updated_at=now()
          WHERE id=$1 AND lender_role=$2 AND lender_id=$3 AND status=$5 RETURNING id,reference,status`,[id,role,req.user.sub,nextStatus,expected]);
    if(!q.rows[0])throw new BadRequestException('Request not found, already handled, or not addressed to your account');
    await this.activity(id,role,req.user.sub,event,{action,reason});
    return {loan:q.rows[0],message:action==='reject'?'Request rejected. The loan remains active.':'Request approved and the loan is now closed.'};
  }

  @Get() @Roles('owner')
  async list(@Req() req:any){const [t,s]=this.scope(req.user);const {rows}=await this.db.pool.query(`SELECT id,reference,item_name AS "itemName",borrower_name AS "borrowerName",phone,id_number AS "idNumber",borrower_email AS "borrowerEmail",imei,serial_number AS "serialNumber",loan_date AS "loanDate",condition_out AS "conditionOut",condition_in AS "conditionIn",amount_kes AS "amountKes",processed_by AS "processedBy",returned,sold,created_at AS "createdAt" FROM loan_items WHERE tenant_id=$1 AND store_id=$2 ORDER BY created_at DESC LIMIT 100`,[t,s]);return {items:rows};}
  @Post() @Roles('owner')
  async create(@Req() req:any,@Body() b:any){
    const [t,s]=this.scope(req.user);
    const required=['itemName','borrowerName','phone','idNumber','loanDate','conditionOut','borrowerEmail'];
    for(const k of required)if(typeof b?.[k]!=='string'||!b[k].trim())throw new BadRequestException(k+' is required');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.borrowerEmail))throw new BadRequestException('Enter a valid borrower email address');
    const amount=Number(b.amountKes);if(!Number.isSafeInteger(amount)||amount<0||amount>100000000)throw new BadRequestException('Enter a valid deposit / value amount');
    if(!isRealDate(b.loanDate)||b.loanDate>new Date().toISOString().slice(0,10))throw new BadRequestException('Enter a valid loan date that is not in the future');
    if(!/^[0-9+() -]{7,25}$/.test(b.phone.trim()))throw new BadRequestException('Enter a valid borrower phone number');
    if(b.imei&&String(b.imei).trim()&&!/^[A-Za-z0-9 ._/-]{6,80}$/.test(String(b.imei).trim()))throw new BadRequestException('Enter a valid IMEI');
    if(b.serialNumber&&String(b.serialNumber).trim()&&!/^[A-Za-z0-9 ._/-]{6,80}$/.test(String(b.serialNumber).trim()))throw new BadRequestException('Enter a valid serial number');
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
    if(shop.logo_data){try{const raw=String(shop.logo_data).replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/,'');d.image(Buffer.from(raw,'base64'),56,y+17,{fit:[86,66]});}catch{}}
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
