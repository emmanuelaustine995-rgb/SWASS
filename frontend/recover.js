(() => {
  'use strict';
  const api = (window.SWASS_API_URL || 'https://swass-api.onrender.com').replace(/\/$/, '');
  const $ = (id) => document.getElementById(id);
  let receipts = [];
  let recoveryToken = '';
  let apiWarmupPromise = null;
  async function warmApi() {
    if (apiWarmupPromise) return apiWarmupPromise;
    apiWarmupPromise = fetch(`${api}/health`, { cache: 'no-store', signal: AbortSignal.timeout(65000) })
      .catch(() => null).finally(() => { apiWarmupPromise = null; });
    return apiWarmupPromise;
  }
  warmApi();
  const keepWarm = setInterval(() => { if (!document.hidden) warmApi(); }, 4 * 60 * 1000);
  window.addEventListener('pagehide', () => clearInterval(keepWarm), { once: true });
  const message = (value) => { $('message').textContent = value; };
  async function readResponse(response) {
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
    if (!response.ok) throw new Error(data.message || `Request failed (${response.status})`);
    return data;
  }
  $('request-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('request-button');
    const nationalId = $('national-id').value.trim();
    const phone = $('phone').value.trim();
    if (!nationalId || !phone) { message('Enter both your National ID and phone number.'); return; }
    button.disabled = true;
    button.textContent = 'Connecting to M-Pesa…';
    $('receipt-list').innerHTML = '';
    try {
      await warmApi();
      message('Checking your customer details…');
      const response = await fetch(`${api}/api/v1/receipt-recovery/request`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nationalId, phone })
      });
      const data = await readResponse(response);
      recoveryToken = data.recoveryToken;
      message('An M-Pesa STK prompt for KSh 10 has been sent. Enter your M-Pesa PIN to pay. One payment unlocks all receipts matching your ID and phone.');
      button.textContent = 'Waiting for M-Pesa payment…';
      await pollPayment(data.paymentId);
    } catch (error) {
      message(error.message || 'Could not start receipt recovery. Please try again.');
      button.disabled = false;
      button.textContent = 'Pay KSh 10 and recover receipts';
    }
  });
  async function pollPayment(paymentId) {
    const started = Date.now();
    while (Date.now() - started < 120000) {
      await new Promise(resolve => setTimeout(resolve, 2500));
      const response = await fetch(`${api}/api/v1/receipt-recovery/status/${encodeURIComponent(paymentId)}`, {
        headers: { 'X-Recovery-Token': recoveryToken }, cache: 'no-store'
      });
      const data = await readResponse(response);
      if (data.status === 'success') {
        message('Payment confirmed. Loading all your receipts…');
        await loadReceipts();
        return;
      }
      if (data.status === 'failed') throw new Error('M-Pesa payment was not completed. Please try again.');
      message('Waiting for payment confirmation from M-Pesa…');
    }
    throw new Error('Payment is still pending. Do not pay again yet. Refresh this page and contact the business if you were charged.');
  }
  async function loadReceipts() {
    const response = await fetch(`${api}/api/v1/receipt-recovery/receipts`, {
      headers: { 'X-Recovery-Token': recoveryToken }, cache: 'no-store'
    });
    const data = await readResponse(response);
    receipts = data.receipts || [];
    if (!receipts.length) {
      message('Payment confirmed, but no receipts were found for these customer details. Please contact the issuing business.');
      return;
    }
    $('receipt-list').innerHTML = '<h2>Recovered receipts (' + receipts.length + ')</h2>' +
      receipts.map((r, index) => `<article class="panel recovered-receipt">
        <div class="history-row-top"><strong>${escapeHtml(r.receipt_no)}</strong><strong>${r.recordType==='loan'?'LOAN NOTE':'KSh '+Number(r.totalKes).toLocaleString('en-KE',{minimumFractionDigits:2})}</strong></div>
        <p>${escapeHtml(r.business_name || r.store_name || '')} · ${escapeHtml(r.store_name || '')}</p>
        <p>${escapeHtml(r.customer_name || 'Customer')} · ${escapeHtml(r.customer_phone || '')}</p>
        <p>${new Date(r.issued_at).toLocaleString('en-KE')} · ${escapeHtml(String(r.status || 'issued'))}</p>
        <p> ${r.recordType==='loan'?'Item on loan: '+escapeHtml(r.item_name||''):(r.items || []).map(item => escapeHtml(item.name) + ' × ' + Number(item.qty)).join(', ')}</p>
        <button type="button" class="print-recovered" data-index="${index}">Print / Save PDF</button>
      </article>`).join('');
    message('Payment confirmed. All ' + receipts.length + ' matching receipts are now unlocked. You can print or save each one as PDF.');
  }
  $('receipt-list').addEventListener('click', (event) => {
    const button = event.target.closest('.print-recovered');
    if (!button) return;
    const r = receipts[Number(button.dataset.index)];
    if (!r) return;
    if(r.recordType==='loan'){
      const win=window.open('','_blank','width=520,height=800');if(!win){message('Allow pop-ups to print this loan note.');return;}
      win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(r.receipt_no)}</title><style>body{font:13px Arial;max-width:620px;margin:24px auto;color:#263445}header{text-align:center;border-bottom:2px solid #1769aa;padding:0 0 14px}header img{max-width:110px;max-height:75px;object-fit:contain}h1{font-size:21px;margin:7px}h2{text-align:center;color:#1769aa;font-size:18px;margin:20px 0 4px}.sub{text-align:center;color:#667789;font-size:10px;letter-spacing:1px}.ref{background:#eaf2fa;padding:12px;border-radius:8px;margin:16px 0}section{margin:15px 0}section h3{font-size:11px;color:#123b63;border-bottom:1px solid #d9e2ec;padding-bottom:6px}p{margin:8px 0}.sign{display:flex;justify-content:space-between;margin-top:45px}.sign span{width:43%;border-top:1px solid #718096;padding-top:7px;font-size:10px;color:#667789}@media print{button{display:none}}</style></head><body><header>${r.logo_data?'<img src="'+escapeHtml(r.logo_data)+'">':''}<h1>${escapeHtml(r.business_name||r.store_name||'Business')}</h1><p>${escapeHtml(r.store_location||'')} · ${escapeHtml(r.business_phone||'')}</p></header><h2>GOODS ON LOAN</h2><p class="sub">OFFICIAL LOAN NOTE · CUSTOMER COPY</p><div class="ref"><b>Loan reference:</b> ${escapeHtml(r.receipt_no)}<br><b>Date issued:</b> ${new Date(r.issued_at).toLocaleDateString('en-KE')}</div><section><h3>BORROWER DETAILS</h3><p><b>Name:</b> ${escapeHtml(r.borrower_name||'')}</p><p><b>Phone:</b> ${escapeHtml(r.phone||'')}</p><p><b>ID / Passport:</b> ${escapeHtml(r.id_number||'')}</p><p><b>Email:</b> ${escapeHtml(r.borrower_email||'')}</p></section><section><h3>ITEM DETAILS</h3><p><b>Item:</b> ${escapeHtml(r.item_name||'')}</p><p><b>IMEI:</b> ${escapeHtml(r.imei||'—')} · <b>Serial:</b> ${escapeHtml(r.serial_number||'—')}</p><p><b>Condition at handover:</b> ${escapeHtml(r.condition_out||'')}</p><p><b>Deposit / value:</b> KSh ${money(r.amount_kes)}</p><p><b>Processed by:</b> ${escapeHtml(r.processed_by||'')}</p><p><b>Status:</b> ${r.returned?'Returned':r.sold?'Sold':'On loan'}</p></section><p>I acknowledge receipt of the item described above in the stated condition.</p><div class="sign"><span>Borrower signature / thumbprint</span><span>Shop representative signature</span></div><p style="text-align:center;color:#667789;margin-top:25px">Keep this document for your records.</p><p style="text-align:center"><button onclick="window.print()">Print / Save PDF</button></p></body></html>`);
      win.document.close();win.focus();return;
    }
    const rows = (r.items || []).map(item => `<tr><td>${escapeHtml(item.name)}${item.serialNo ? '<br>IMEI: '+escapeHtml(item.serialNo) : ''}</td><td>${Number(item.qty)}</td><td>KSh ${money(item.unitPriceKes)}</td><td>KSh ${money(item.lineTotalKes)}</td></tr>`).join('');
    const win = window.open('', '_blank', 'width=480,height=800');
    if (!win) { message('Allow pop-ups to print this receipt.'); return; }
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(r.receipt_no)}</title>
      <style>body{font:13px Arial;max-width:420px;margin:20px auto;color:#111}header{text-align:center;border-bottom:1px dashed #777;padding-bottom:12px}h1{font-size:20px}table{width:100%;border-collapse:collapse}td,th{padding:7px 3px;border-bottom:1px solid #ddd;text-align:left}td:last-child,th:last-child{text-align:right}.total{text-align:right;font-size:18px;font-weight:bold;margin-top:14px}.stamp{text-align:center;border:2px solid #a22;color:#a22;padding:12px;margin:20px auto;width:120px;font-weight:bold}.center{text-align:center}@media print{button{display:none}}</style></head><body>
      <header>${r.logo_data ? '<img src="'+escapeHtml(r.logo_data)+'" style="max-width:100px;max-height:70px">' : ''}<h1>${escapeHtml(r.business_name || r.store_name || 'Business')}</h1><p>${escapeHtml(r.store_location || '')}</p><p>${escapeHtml(r.business_phone || '')}</p><b>OFFICIAL SALES RECEIPT</b></header>
      <p><b>Receipt:</b> ${escapeHtml(r.receipt_no)}<br><b>Date:</b> ${new Date(r.issued_at).toLocaleString('en-KE')}<br><b>Customer:</b> ${escapeHtml(r.customer_name || 'Customer')}<br><b>Phone:</b> ${escapeHtml(r.customer_phone || '')}<br><b>Sales agent:</b> ${escapeHtml(r.cashier?.name || 'Staff')}<br><b>Payment:</b> ${escapeHtml(String(r.payment_method || '').toUpperCase())}</p>
      <table><thead><tr><th>Product</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="total">TOTAL: KSh ${money(r.totalKes)}</p><div class="stamp">PAID<br>${new Date(r.issued_at).toLocaleDateString('en-KE')}</div><p class="center"><b>Thank you for shopping with us!</b></p><p class="center">Recovered through SWASS</p><p class="center"><button onclick="window.print()">Print / Save PDF</button></p>
      </body></html>`);
    win.document.close(); win.focus();
  });
  function money(value) { return Number(value || 0).toLocaleString('en-KE',{minimumFractionDigits:2}); }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // Separate KSh 50 recovery for saved second-hand Special Receipts.
  let specialRecoveryToken = '';
  const specialMessage = (value) => { $('special-message').textContent = value; };
  $('special-request-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('special-request-button');
    const nationalId = $('special-national-id').value.trim();
    const phone = $('special-phone').value.trim();
    if (!nationalId || !phone) { specialMessage('Enter the seller National ID and phone number.'); return; }
    button.disabled = true;
    button.textContent = 'Connecting to M-Pesa…';
    $('special-receipt-list').innerHTML = '';
    try {
      await warmApi();
      const response = await fetch(`${api}/api/v1/second-hand-special-recovery/request`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nationalId, phone })
      });
      const data = await readResponse(response);
      specialRecoveryToken = data.recoveryToken;
      specialMessage('M-Pesa prompt requested for KSh 50. Enter your M-Pesa PIN, then wait for payment confirmation.');
      button.textContent = 'Waiting for KSh 50 payment…';
      await pollSpecialPayment(data.paymentId);
    } catch (error) {
      specialMessage(error.message || 'Could not start Special Receipt recovery.');
      button.disabled = false;
      button.textContent = 'Pay KSh 50 and recover Special Receipt';
    }
  });
  async function pollSpecialPayment(paymentId) {
    const started = Date.now();
    while (Date.now() - started < 120000) {
      await new Promise(resolve => setTimeout(resolve, 2500));
      const response = await fetch(`${api}/api/v1/second-hand-special-recovery/status/${encodeURIComponent(paymentId)}`, {
        headers: { 'X-Recovery-Token': specialRecoveryToken }, cache: 'no-store'
      });
      const data = await readResponse(response);
      if (data.status === 'success') {
        specialMessage('KSh 50 payment confirmed. Loading your Special Receipt…');
        await loadSpecialDeclaration();
        return;
      }
      if (data.status === 'failed') throw new Error('M-Pesa payment was not completed. Please try again.');
      specialMessage('Waiting for M-Pesa payment confirmation…');
    }
    throw new Error('Payment is still pending. Do not pay again yet. Refresh later and check before retrying.');
  }
  async function loadSpecialDeclaration() {
    const response = await fetch(`${api}/api/v1/second-hand-special-recovery/declaration`, {
      headers: { 'X-Recovery-Token': specialRecoveryToken }, cache: 'no-store'
    });
    const data = await readResponse(response);
    const d = data.declaration || {};
    const fields = [
      ['Special Receipt reference', d.declarationRef], ['Seller full name', d.sellerName],
      ['National ID', d.nationalId], ['Seller phone', d.sellerPhone],
      ['Alternative phone', d.alternativePhone], ['Residential address', d.residentialAddress],
      ['Goods / make and model', d.productName], ['IMEI / identifier', d.imei1],
      ['Second IMEI', d.imei2], ['Serial number', d.serialNumber],
      ['Condition', d.condition], ['Agreed purchase price', 'KSh ' + money(d.purchasePriceKes)],
      ['Original receipt status', d.receiptStatus], ['Witness', d.witnessName],
      ['Witness phone', d.witnessPhone], ['Declaration accepted', 'Yes'],
      ['Shop acknowledgement', d.shopAcknowledged ? 'Yes' : 'No'],
      ['Date recorded', d.createdAt ? new Date(d.createdAt).toLocaleString('en-KE') : '']
    ];
    $('special-receipt-list').innerHTML = `<article class="panel recovered-receipt">
      <h2>Second-Hand Goods Special Receipt</h2>
      <p><strong>Reference:</strong> ${escapeHtml(d.declarationRef || '')}</p>
      ${fields.slice(1).map(([label,value]) => value ? `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>` : '').join('')}
      <p><button type="button" id="print-special-receipt">Print / Save PDF</button></p>
    </article>`;
    $('print-special-receipt').addEventListener('click', () => {
      const win = window.open('', '_blank', 'width=520,height=800');
      if (!win) { specialMessage('Allow pop-ups to print this Special Receipt.'); return; }
      win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Special Receipt ${escapeHtml(d.declarationRef || '')}</title>
        <style>body{font:14px Arial;max-width:620px;margin:24px auto;color:#111}h1{text-align:center;font-size:22px}h2{text-align:center}p{padding:7px 0;border-bottom:1px solid #ddd}.notice{border:1px solid #555;padding:12px;margin-top:18px}@media print{button{display:none}}</style>
        </head><body><h1>AURORA E-RECEIPT</h1><h2>SECOND-HAND GOODS SPECIAL RECEIPT</h2>
        <p><b>Reference:</b> ${escapeHtml(d.declarationRef || '')}</p>
        ${fields.slice(1).map(([label,value]) => value ? `<p><b>${escapeHtml(label)}:</b> ${escapeHtml(value)}</p>` : '').join('')}
        <div class="notice">This document records the seller's declaration and the shop's acknowledgement as stored at the time of signing. It is a record of the declaration, not a guarantee of legal outcome.</div>
        <p style="text-align:center"><button onclick="window.print()">Print / Save PDF</button></p></body></html>`);
      win.document.close(); win.focus();
    });
    specialMessage('Payment confirmed. Your saved Second-Hand Goods Special Receipt is unlocked.');
    $('special-request-button').disabled = false;
    $('special-request-button').textContent = 'Recover another Special Receipt';
  }
})();