import { Injectable } from '@nestjs/common';

@Injectable()
export class WhatsAppReceiptService {
  async sendPdf(input: { to: string; receiptNo: string; businessName: string; pdf: Buffer }) {
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const graphVersion = process.env.WHATSAPP_GRAPH_VERSION || 'v22.0';
    if (!token || !phoneNumberId) throw new Error('WhatsApp Cloud API is not configured');
    const phone = input.to.replace(/\D/g, '');
    const normalised = phone.startsWith('0') ? '254' + phone.slice(1) : phone.startsWith('254') ? phone : '254' + phone;
    if (!/^254[17]\d{8}$/.test(normalised)) throw new Error('Invalid customer WhatsApp number');
    const base = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}`;
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', 'application/pdf');
    form.append('file', new Blob([new Uint8Array(input.pdf)], { type: 'application/pdf' }), `${input.receiptNo}.pdf`);
    const upload = await fetch(`${base}/media`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
      signal: AbortSignal.timeout(20000),
    });
    const uploaded = await upload.json() as { id?: string; error?: { message?: string } };
    if (!upload.ok || !uploaded.id) throw new Error(uploaded.error?.message || `WhatsApp media upload failed (${upload.status})`);
    const sent = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', recipient_type: 'individual', to: normalised,
        type: 'document',
        document: {
          id: uploaded.id, filename: `${input.receiptNo}.pdf`,
          caption: `Thank you for shopping with ${input.businessName}. Your receipt ${input.receiptNo} is attached.`,
        },
      }),
      signal: AbortSignal.timeout(20000),
    });
    const result = await sent.json() as { messages?: { id?: string }[]; error?: { message?: string } };
    if (!sent.ok || !result.messages?.[0]?.id) throw new Error(result.error?.message || `WhatsApp message failed (${sent.status})`);
    return { sent: true, messageId: result.messages[0].id };
  }
}
