import { Injectable } from '@nestjs/common';

@Injectable()
export class WhatsAppReceiptService {
  async sendText(input:{to:string;text:string}) {
    const phone=input.to.replace(/\D/g,'');
    const normalised=phone.startsWith('0')?'254'+phone.slice(1):phone.startsWith('254')?phone:'254'+phone;
    if(!/^254[17]\d{8}$/.test(normalised))throw new Error('Invalid WhatsApp number');
    const provider=(process.env.WHATSAPP_PROVIDER||'flaresend').trim().toLowerCase();
    if(provider==='flaresend'){
      const apiKey=process.env.FLARESEND_API_KEY?.trim();if(!apiKey)throw new Error('FlareSend API key is not configured');
      const response=await fetch('https://api.flaresend.com/send-message',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify({recipients:[normalised],type:'text',text:input.text}),signal:AbortSignal.timeout(15000)});
      const result=await response.json() as any;if(!response.ok||result.success===false||(Array.isArray(result.failed_recipients)&&result.failed_recipients.length))throw new Error(result.message||result.error||'FlareSend alert failed');
      return {sent:true,provider:'flaresend'};
    }
    if(provider==='cloud'){
      const token=process.env.WHATSAPP_ACCESS_TOKEN,phoneNumberId=process.env.WHATSAPP_PHONE_NUMBER_ID,version=process.env.WHATSAPP_GRAPH_VERSION||'v22.0';
      if(!token||!phoneNumberId)throw new Error('WhatsApp Cloud API is not configured');
      const response=await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to:normalised,type:'text',text:{body:input.text}}),signal:AbortSignal.timeout(15000)});
      const result=await response.json() as any;if(!response.ok||!result.messages?.[0]?.id)throw new Error(result.error?.message||'WhatsApp alert failed');return {sent:true,provider:'cloud'};
    }
    throw new Error('Unsupported WhatsApp provider');
  }

  async sendPdf(input: { to: string; receiptNo: string; businessName: string; pdf: Buffer }) {
    const phone = input.to.replace(/\D/g, '');
    const normalised = phone.startsWith('0') ? '254' + phone.slice(1) : phone.startsWith('254') ? phone : '254' + phone;
    if (!/^254[17]\d{8}$/.test(normalised)) throw new Error('Invalid customer WhatsApp number');

    const provider = (process.env.WHATSAPP_PROVIDER || 'flaresend').trim().toLowerCase();
    if (provider === 'flaresend') return this.sendWithFlareSend({ ...input, phone: normalised });
    if (provider !== 'cloud') throw new Error('Unsupported WHATSAPP_PROVIDER. Use cloud or flaresend.');

    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const graphVersion = process.env.WHATSAPP_GRAPH_VERSION || 'v22.0';
    if (!token || !phoneNumberId) throw new Error('WhatsApp Cloud API is not configured');
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
    const templateName = process.env.WHATSAPP_RECEIPT_TEMPLATE_NAME?.trim();
    const language = process.env.WHATSAPP_RECEIPT_TEMPLATE_LANGUAGE?.trim() || 'en';
    const messageBody = templateName
      ? {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: normalised,
          type: 'template',
          template: {
            name: templateName,
            language: { code: language },
            components: [{
              type: 'header',
              parameters: [{ type: 'document', document: { id: uploaded.id, filename: `${input.receiptNo}.pdf` } }],
            }],
          },
        }
      : {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: normalised,
          type: 'document',
          document: {
            id: uploaded.id, filename: `${input.receiptNo}.pdf`,
            caption: `Thank you for shopping with ${input.businessName}. Your receipt ${input.receiptNo} is attached.`,
          },
        };
    const sent = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(messageBody),
      signal: AbortSignal.timeout(20000),
    });
    const result = await sent.json() as { messages?: { id?: string }[]; error?: { message?: string; code?: number; error_subcode?: number } };
    if (!sent.ok || !result.messages?.[0]?.id) {
      const reason = result.error?.message || `WhatsApp message failed (${sent.status})`;
      if (!templateName && (result.error?.code === 131047 || /24.hour|outside.*window|re.engagement/i.test(reason))) {
        throw new Error('WhatsApp requires an approved receipt template for first-time or out-of-window messages. Configure WHATSAPP_RECEIPT_TEMPLATE_NAME and WHATSAPP_RECEIPT_TEMPLATE_LANGUAGE in Render.');
      }
      throw new Error(reason);
    }
    return { sent: true, messageId: result.messages[0].id, provider: 'cloud', mode: templateName ? 'template' : 'session' };
  }

  private async sendWithFlareSend(input: { to: string; receiptNo: string; businessName: string; pdf: Buffer; phone: string }) {
    const apiKey = process.env.FLARESEND_API_KEY?.trim();
    if (!apiKey) throw new Error('FlareSend is selected but FLARESEND_API_KEY is not configured');
    const form = new FormData();
    form.append('recipients[]', input.phone);
    form.append('type', 'document');
    form.append('file', new Blob([new Uint8Array(input.pdf)], { type: 'application/pdf' }), `${input.receiptNo}.pdf`);
    form.append('caption', `Thank you for shopping with ${input.businessName}. Your receipt ${input.receiptNo} is attached.`);
    const response = await fetch('https://api.flaresend.com/send-message', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    const raw = await response.text();
    let result: any = {};
    try { result = raw ? JSON.parse(raw) : {}; } catch { /* retain provider response status */ }
    if (!response.ok || result.success === false || (Array.isArray(result.failed_recipients) && result.failed_recipients.length > 0)) {
      throw new Error(result.message || result.error || `FlareSend WhatsApp delivery failed (${response.status})`);
    }
    const recipient = Array.isArray(result.successful_recipients) ? result.successful_recipients[0] : undefined;
    return { sent: true, messageId: result.messageId || result.message_id || null, recipient, provider: 'flaresend' };
  }
}
