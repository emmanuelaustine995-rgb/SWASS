import PDFDocument = require('pdfkit');

export function buildSecondHandDeclarationPdf(d: any, options: { pendingShopReview?: boolean } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 46, bufferPages: true, info: {
      Title: 'AURORA Sales Declaration ' + (d.declarationRef || ''),
      Author: 'AURORA E-RECEIPT',
      Subject: 'Complete copy of the submitted Sales Declaration Form',
    } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const clean = (value: unknown) => String(value ?? '—').normalize('NFKD').replace(/[^\x20-\x7E]/g, ' ');
    const heading = (value: string) => {
      doc.moveDown(.65).font('Helvetica-Bold').fontSize(11).fillColor('#075b74').text(clean(value));
      doc.moveDown(.2);
    };
    const line = (label: string, value: unknown) => {
      doc.font('Helvetica-Bold').fontSize(8.7).fillColor('#17324d').text(clean(label) + ': ', { continued: true });
      doc.font('Helvetica').fontSize(8.7).fillColor('#263746').text(clean(value));
    };
    const paragraph = (value: string) => {
      doc.font('Helvetica').fontSize(8.7).fillColor('#263746').text(clean(value), { align: 'justify', lineGap: 2 });
    };
    const ensureSpace = (height: number) => {
      if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage();
    };
    const addImage = (label: string, data?: string) => {
      if (typeof data !== 'string' || !data.startsWith('data:image/')) return;
      try {
        const raw = Buffer.from(data.split(',')[1] || '', 'base64');
        if (!raw.length) return;
        ensureSpace(145);
        doc.moveDown(.35).font('Helvetica-Bold').fontSize(8.7).fillColor('#17324d').text(clean(label));
        const y = doc.y + 4;
        doc.image(raw, 46, y, { fit: [250, 112], align: 'left', valign: 'top' });
        doc.y = y + 118;
      } catch {
        ensureSpace(24);
        doc.font('Helvetica').fontSize(8).fillColor('#8a3b32').text(clean(label) + ': submitted image could not be embedded in this PDF copy');
      }
    };

    const submittedAt = d.createdAt || d.acceptedAt || Date.now();
    const withReceipt = d.saleType === 'with_receipt';
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#075b74').text('AURORA E-RECEIPT');
    doc.fontSize(14).fillColor('#172b45').text('SALES DECLARATION FORM');
    doc.moveDown(.25).font('Helvetica').fontSize(8.5).fillColor('#526477');
    doc.text('Declaration reference: ' + clean(d.declarationRef));
    doc.text('Submitted / recorded: ' + clean(new Date(submittedAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })));
    if (options.pendingShopReview) {
      doc.moveDown(.4).font('Helvetica-Bold').fontSize(9).fillColor('#805b00')
        .text('CUSTOMER SUBMISSION - PENDING SHOP REVIEW - NOT AN APPROVED SHOP RECEIPT');
    }
    doc.moveDown(.3).moveTo(46, doc.y).lineTo(550, doc.y).strokeColor('#9bb7c8').stroke();

    heading('1. SELLER IDENTIFICATION');
    line('Full legal name', d.sellerName);
    line('National ID / Passport number', d.nationalId);
    line('Seller phone number', d.sellerPhone);
    line('Seller email address', d.sellerEmail);
    line('Alternative phone (optional)', d.alternativePhone || 'Not supplied');
    line('Residential address / area', d.residentialAddress);

    heading('2. BUYER DETAILS');
    line('Buyer full name', d.buyerName);
    line('Buyer National ID number', d.buyerNationalId);
    line('Buyer phone number', d.buyerPhone);
    line('Buyer email address', d.buyerEmail);

    heading('3. PRODUCT BEING SOLD');
    line('Product name / make and model', d.productName || d.phoneMakeModel);
    line('Product identifier / barcode / serial number (IMEI for phones, if applicable)', d.imei1 || 'Not supplied');
    line('Second identifier (if applicable)', d.imei2 || 'Not supplied');
    line('Additional serial number / identifying details (if available)', d.serialNumber || 'Not supplied');
    line('Product condition', d.condition);
    line('Agreed purchase price (KSh)', 'KSh ' + Number(d.purchasePriceKes || 0).toLocaleString('en-KE'));
    line('Receipt option selected', withReceipt ? 'WITH RECEIPT' : 'WITHOUT RECEIPT');
    if (withReceipt) {
      line('Photograph of original purchase receipt', d.receiptPhotoData ? 'Attached below' : 'Not supplied');
    } else {
      line('Why is the original product purchase receipt unavailable?', d.noReceiptReason || 'Not supplied');
    }

    heading('4. SELLER OWNERSHIP AND RESPONSIBILITY DECLARATION');
    doc.font('Helvetica-Bold').fontSize(8.8).fillColor('#17324d')
      .text(withReceipt ? 'DECLARATION - PRODUCT WITH ORIGINAL RECEIPT' : 'DECLARATION - PRODUCT WITHOUT ORIGINAL RECEIPT');
    paragraph(withReceipt
      ? 'I declare that I am the lawful owner of the product recorded above or have full legal authority to sell it. I confirm that the original purchase receipt shown and attached to this record relates to this product and, to the best of my knowledge, is genuine and has not been altered. I confirm that the product is not stolen, unlawfully obtained, fraudulently acquired or subject to an ownership dispute, and that all product identifiers and details I have supplied are true. I accept responsibility for false statements, a false or altered receipt, fraudulent representation or an unlawful ownership claim connected with this sale. I agree to cooperate with lawful investigations and provide further information when lawfully required. I understand that this declaration may be retained and disclosed to lawful authorities when required.'
      : 'I declare that I am the lawful owner of the product recorded above or have full legal authority to sell it, even though I cannot provide its original purchase receipt. I have truthfully explained why the receipt is unavailable and confirm that, to the best of my knowledge, the product is not stolen, unlawfully obtained, fraudulently acquired or subject to an ownership dispute. I confirm that all product identifiers and details I have supplied are true and have not knowingly been altered. I accept responsibility for false statements, fraudulent representation or an unlawful ownership claim connected with this sale. I agree to cooperate with lawful investigations and provide further information when lawfully required. I understand that this declaration may be retained and disclosed to lawful authorities when required.');

    heading('5. SELLER CONFIRMATION');
    paragraph('I have read or had this declaration read to me, understood it, and confirm that the information I have supplied is true.');
    line('Seller declaration accepted', d.declarationAccepted ? 'YES - confirmed on the form' : 'NO');
    line('Seller electronic signature', d.signatureData ? 'Signed - image attached below' : 'Not supplied');
    if (!withReceipt) line('Seller electronic thumbprint mark', d.thumbprintData ? 'Drawn mark attached below (not a biometric scan)' : 'Not supplied');

    heading('6. SHOP AND WITNESS RECORD');
    line('Witness full name (optional)', d.witnessName || 'Not supplied');
    line('Witness phone (optional)', d.witnessPhone || 'Not supplied');
    line('Shop representative', d.shopRepresentativeName || 'Not supplied / pending shop review');
    line('Shop representative acknowledgement', d.shopAcknowledged ? 'Confirmed' : options.pendingShopReview ? 'Pending shop review' : 'Not confirmed');
    paragraph("I, as the shop representative, confirm that I checked the seller's identification and compared the product identifiers with the item before accepting it.");
    line('Shop acknowledgement recorded', d.shopAcknowledged ? 'YES' : 'NO / PENDING');
    line('Server recorded date and time', new Date(submittedAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }));

    heading('7. PHOTOGRAPHS AND SIGNATURE EVIDENCE SUBMITTED WITH THIS FORM');
    addImage('Seller ID photo (front)', d.idPhotoData);
    addImage('Seller / client photo (optional when receipt is supplied; required without receipt)', d.sellerPhotoData);
    addImage('Photo of the product and its identifying details', d.phonePhotoData);
    addImage('Photograph of original purchase receipt', d.receiptPhotoData);
    addImage("Seller's electronic signature", d.signatureData);
    if (!withReceipt) addImage("Seller's electronic thumbprint mark (finger-drawn, not a biometric fingerprint scan)", d.thumbprintData);

    ensureSpace(55);
    doc.moveDown(.5).font('Helvetica').fontSize(7.5).fillColor('#65758a')
      .text('This PDF reproduces the declaration wording, submitted field values, acknowledgements and evidence saved from the form. It does not independently verify identity or establish legal ownership.', { align: 'justify' });
    doc.end();
  });
}
