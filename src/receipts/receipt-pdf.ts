import PDFDocument = require('pdfkit');
import QRCode from 'qrcode';
export interface ReceiptPdfInput {
 receiptNo:string; issuedAt:string|Date; businessName:string; businessPhone?:string; businessEmail?:string;
 storeName?:string; storeLocation?:string; logoData?:string; receiptHeader?:string; receiptFooter?:string;
 customerName?:string; customerPhone?:string; customerEmail?:string; cashierName?:string; cashierPhone?:string;
 paymentMethod:string; subtotalKes:number; discountKes:number; totalKes:number; verificationUrl?:string; recoveryUrl?:string;
 items:{name:string;qty:number;unitPriceKes:number;lineTotalKes:number;serialNo?:string|null}[];
}
export async function buildReceiptPdf(input:ReceiptPdfInput):Promise<Buffer>{
 const verifyQr=input.verificationUrl?await QRCode.toBuffer(input.verificationUrl,{type:'png',width:180,margin:1}):null;
 const serialQrs=await Promise.all(input.items.map(x=>x.serialNo?QRCode.toBuffer(x.serialNo,{type:'png',width:110,margin:1}):null));
 return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({size:[226,842],margin:14,bufferPages:true,info:{Title:`Receipt ${input.receiptNo}`,Author:input.businessName}});
  const chunks:Buffer[]=[];doc.on('data',x=>chunks.push(Buffer.from(x)));doc.on('error',reject);doc.on('end',()=>resolve(Buffer.concat(chunks)));
  const l=14,w=198,m=(n:number)=>Number(n||0).toLocaleString('en-KE',{minimumFractionDigits:2,maximumFractionDigits:2});
  const center=(v:string,size=8,bold=false)=>{doc.font(bold?'Helvetica-Bold':'Helvetica').fontSize(size).fillColor('#17251f').text(v,l,doc.y,{width:w,align:'center'});doc.moveDown(.2);};
  const rule=()=>{const y=doc.y+3;doc.moveTo(l,y).lineTo(212,y).dash(2,{space:3}).strokeColor('#82938a').stroke();doc.undash();doc.y=y+9;};
  const row=(a:string,b:string)=>{doc.font('Helvetica').fontSize(8).fillColor('#222').text(a,l,doc.y,{continued:true});doc.font('Helvetica-Bold').text(b,{align:'right'});doc.moveDown(.15);};
  if(input.logoData?.startsWith('data:image/'))try{const b=input.logoData.split(',')[1];if(b){doc.image(Buffer.from(b,'base64'),78,doc.y,{fit:[70,48]});doc.y+=52;}}catch{}
  center(input.businessName||'BUSINESS NAME',14,true);
  for(const v of [input.storeName,input.storeLocation,input.businessPhone?'Tel: '+input.businessPhone:'',input.businessEmail?'Email: '+input.businessEmail:'',input.receiptHeader||''])if(v)center(v,7);
  center('OFFICIAL SALES RECEIPT',8,true);rule();
  row('Receipt',input.receiptNo);row('Date sold',new Date(input.issuedAt).toLocaleString('en-KE',{timeZone:'Africa/Nairobi'}));
  row('Sales agent',input.cashierName||'Staff');if(input.cashierPhone)row('Agent phone',input.cashierPhone);
  row('Payment',input.paymentMethod.toUpperCase());if(input.customerName)row('Customer',input.customerName);
  if(input.customerPhone)row('Phone',input.customerPhone);if(input.customerEmail)row('Email',input.customerEmail);rule();
  doc.font('Helvetica-Bold').fontSize(8).text('ITEM / DESCRIPTION',l,doc.y);doc.moveDown(.3);
  input.items.forEach((item,i)=>{
   doc.font('Helvetica-Bold').fontSize(8).text(item.name,l,doc.y,{width:w});doc.moveDown(.1);
   doc.font('Helvetica').fontSize(7).text(`${item.qty} × KSh ${m(item.unitPriceKes)}`,l,doc.y,{continued:true});
   doc.text(`KSh ${m(item.lineTotalKes)}`,{align:'right'});
   if(item.serialNo){doc.fontSize(7).text('IMEI / Serial: '+item.serialNo,l,doc.y);doc.moveDown(.2);if(serialQrs[i]){const y=doc.y;doc.image(serialQrs[i]!,l,y,{width:38,height:38});doc.y=y+40;}}
   doc.moveDown(.25);rule();
  });
  row('Subtotal','KSh '+m(input.subtotalKes));row('Discount','KSh '+m(input.discountKes));
  const y=doc.y;doc.roundedRect(l,y,w,27,5).fill('#e8f3ed');doc.fillColor('#145c43').font('Helvetica-Bold').fontSize(10).text('TOTAL PAID  KSh '+m(input.totalKes),l+4,y+8,{width:w-8,align:'center'});doc.y=y+37;
  const sy=doc.y;doc.save().rotate(-7,{origin:[113,sy+43]});doc.circle(113,sy+43,40).lineWidth(2).strokeColor('#a32626').stroke();doc.circle(113,sy+43,35).lineWidth(.7).strokeColor('#a32626').stroke();
  doc.fillColor('#a32626').font('Helvetica-Bold').fontSize(7).text(input.businessName.toUpperCase(),l+15,sy+20,{width:168,align:'center'});
  doc.fontSize(19).text('PAID',l,sy+32,{width:w,align:'center'});doc.fontSize(6).text('DATE: '+new Date(input.issuedAt).toLocaleDateString('en-KE',{timeZone:'Africa/Nairobi'}),l,sy+55,{width:w,align:'center'});doc.restore();doc.y=sy+91;
  if(verifyQr){center('SCAN TO VERIFY RECEIPT',8,true);const qy=doc.y;doc.image(verifyQr,88,qy,{width:50,height:50});doc.y=qy+53;}
  center('Thank you for shopping with us!',8,true);if(input.receiptFooter)center(input.receiptFooter,7);
  if(input.recoveryUrl){center('Lost this receipt? Recover it using your phone and OTP.',6);center(input.recoveryUrl,5);}
  doc.end();
 });
}
