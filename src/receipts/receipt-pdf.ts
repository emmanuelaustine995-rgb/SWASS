import PDFDocument = require('pdfkit');

export interface ReceiptPdfInput {
  receiptNo: string; issuedAt: string | Date; businessName: string; businessPhone?: string;
  businessEmail?: string; storeName?: string; storeLocation?: string; logoData?: string;
  customerName?: string; customerPhone?: string; cashierName?: string; cashierPhone?: string;
  paymentMethod: string; subtotalKes: number; discountKes: number; totalKes: number;
  items: { name: string; qty: number; unitPriceKes: number; lineTotalKes: number; serialNo?: string | null }[];
}
export async function buildReceiptPdf(input: ReceiptPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Receipt ${input.receiptNo}`, Author: input.businessName } });
    const chunks: Buffer[] = [];
    doc.on('data', chunk => chunks.push(Buffer.from(chunk)));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    const money = (n: number) => Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const line = (y: number) => doc.moveTo(48, y).lineTo(547, y).strokeColor('#cbd5d1').stroke();
    if (input.logoData?.startsWith('data:image/')) {
      try { const encoded = input.logoData.split(',')[1]; if (encoded) doc.image(Buffer.from(encoded, 'base64'), 48, 38, { fit: [76, 58] }); } catch { /* Ignore invalid logo and keep the receipt readable. */ }
    }
    doc.fontSize(20).fillColor('#145c43').text(input.businessName, 135, 42, { width: 410 });
    doc.fontSize(9).fillColor('#333').text([input.storeName, input.storeLocation, input.businessPhone, input.businessEmail].filter(Boolean).join(' · '), 135, 70, { width: 410 });
    line(112);
    doc.fontSize(15).fillColor('#111').text('SALES RECEIPT', 48, 128);
    doc.fontSize(10).text(`Receipt: ${input.receiptNo}`, 48, 157);
    doc.text(`Date: ${new Date(input.issuedAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}`, 48, 174);
    doc.text(`Customer: ${input.customerName || 'Walk-in customer'}`, 48, 191);
    doc.text(`Phone: ${input.customerPhone || '—'}`, 48, 208);
    doc.text(`Sales agent: ${input.cashierName || 'Staff'}`, 48, 225);
    doc.text(`Payment: ${String(input.paymentMethod || '').toUpperCase()}`, 48, 242);
    let y = 282;
    line(y);
    doc.font('Helvetica-Bold').fontSize(9).text('ITEM', 48, y + 9).text('QTY', 340, y + 9, { width: 35, align: 'right' }).text('UNIT', 380, y + 9, { width: 75, align: 'right' }).text('TOTAL', 465, y + 9, { width: 82, align: 'right' });
    y += 30; line(y);
    doc.font('Helvetica').fontSize(9);
    for (const item of input.items) {
      if (y > 700) { doc.addPage(); y = 55; }
      const label = item.name + (item.serialNo ? `\nIMEI/Serial: ${item.serialNo}` : '');
      doc.text(label, 48, y + 8, { width: 275 });
      doc.text(String(item.qty), 340, y + 8, { width: 35, align: 'right' });
      doc.text(`KSh ${money(item.unitPriceKes)}`, 380, y + 8, { width: 75, align: 'right' });
      doc.text(`KSh ${money(item.lineTotalKes)}`, 465, y + 8, { width: 82, align: 'right' });
      y += item.serialNo ? 38 : 25; line(y);
    }
    y += 18;
    doc.fontSize(10).text(`Subtotal: KSh ${money(input.subtotalKes)}`, 350, y, { width: 197, align: 'right' }); y += 18;
    doc.text(`Discount: KSh ${money(input.discountKes)}`, 350, y, { width: 197, align: 'right' }); y += 24;
    doc.font('Helvetica-Bold').fontSize(15).fillColor('#145c43').text(`TOTAL PAID: KSh ${money(input.totalKes)}`, 250, y, { width: 297, align: 'right' });
    y += 55;
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#145c43').text('PAID', 48, y, { width: 499, align: 'center' });
    doc.font('Helvetica').fontSize(10).fillColor('#333').text('Thank you for shopping with us!', 48, y + 22, { width: 499, align: 'center' });
    doc.end();
  });
}
