(() => {
  'use strict';
  const api = (window.SWASS_API_URL || 'http://localhost:3000').replace(/\/$/, '');
  const $ = (id) => document.getElementById(id);
  let phone = '';
  let requestStarted = false;
  let recoveredReceipts = [];
  const message = (text) => { $('message').textContent = text; };
  async function readResponse(response) {
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
    if (!response.ok) throw new Error(data.message || `Request failed (${response.status})`);
    return data;
  }
  $('request-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (requestStarted) return;
    phone = $('phone').value.trim();
    if (!phone) { message('Enter the phone number used on the receipt.'); return; }
    requestStarted = true;
    const button = $('request-form').querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Requesting…';
    $('code').value = '';
    $('receipt-list').innerHTML = '';
    message('Requesting verification code…');
    try {
      const r = await fetch(`${api}/api/v1/receipt-recovery/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      });
      const data = await readResponse(r);
      $('verify-form').classList.remove('hidden');
      $('phone').readOnly = true;
      message(data.developmentCode
        ? `Development test code: ${data.developmentCode}`
        : 'If matching receipts exist, a code has been sent. Enter the newest six-digit code within 5 minutes.');
      $('code').focus();
    } catch (err) {
      // A browser/network response can fail after the API has already sent the SMS.
      // Allow verification if the customer actually received a code.
      const networkFailure = err instanceof TypeError;
      if (networkFailure) {
        $('verify-form').classList.remove('hidden');
        $('phone').readOnly = true;
        message('The request response could not be read. If the SMS arrived, enter its newest six-digit code. Do not request another code yet.');
        $('code').focus();
      } else {
        requestStarted = false;
        button.disabled = false;
        button.textContent = 'Send verification code';
        message(err.message || 'Could not request a code. Please try again.');
      }
    } finally {
      if (requestStarted) {
        button.textContent = 'Code requested';
      }
    }
  });
  $('verify-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('code').value.replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) { message('Enter all six digits from the latest SMS.'); return; }
    const button = $('verify-form').querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Verifying…';
    message('Verifying code…');
    try {
      const r = await fetch(`${api}/api/v1/receipt-recovery/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, code })
      });
      const data = await readResponse(r);
      const list = await fetch(`${api}/api/v1/receipt-recovery/receipts`, {
        headers: { 'X-Recovery-Token': data.recoveryToken }
      });
      const found = await readResponse(list);
      recoveredReceipts = found.receipts || [];
      $('receipt-list').innerHTML = recoveredReceipts.length
        ? recoveredReceipts.map((r, i) => `<article class="panel recovered-receipt"><div class="history-row-top"><strong>${escapeHtml(r.receipt_no)}</strong><strong>KSh ${Number(r.totalKes).toLocaleString('en-KE',{minimumFractionDigits:2})}</strong></div><p>${escapeHtml(r.business_name || r.store_name)} · ${escapeHtml(r.store_name || '')}</p><p>${escapeHtml(r.customer_name || 'Customer')} · ${escapeHtml(r.customer_phone || '')}</p><p>${new Date(r.issued_at).toLocaleString('en-KE')} · ${escapeHtml(r.status)} · ${escapeHtml(String(r.payment_method || '').toUpperCase())}</p><div>${(r.items || []).map(item => `<div class="history-row-meta">${escapeHtml(item.name)} × ${Number(item.qty)} — KSh ${Number(item.lineTotalKes).toLocaleString('en-KE',{minimumFractionDigits:2})}</div>`).join('')}</div><button type="button" class="print-recovered" data-index="${i}">Print receipt</button></article>`).join('')
        : '<p>No receipts were found.</p>';
      message('Phone verified. Your receipts are shown below. This recovery session expires in 10 minutes.');
    } catch (err) {
      message(err.message || 'Verification failed. Check the latest SMS code and try again.');
    } finally {
      button.disabled = false;
      button.textContent = 'Verify and find receipts';
    }
  });
  $('receipt-list').addEventListener('click', (e) => {
    const button = e.target.closest('.print-recovered');
    if (!button) return;
    const r = recoveredReceipts[Number(button.dataset.index)];
    if (!r) return;
    const items = (r.items || []).map(item => `<tr><td>${escapeHtml(item.name)}</td><td>${Number(item.qty)}</td><td>KSh ${Number(item.lineTotalKes).toLocaleString('en-KE',{minimumFractionDigits:2})}</td></tr>`).join('');
    const logo = r.logo_data ? `<img class="logo" src="${escapeHtml(r.logo_data)}" alt="Business logo">` : '';
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(r.receipt_no)}</title><style>body{font:14px Arial,sans-serif;max-width:360px;margin:20px auto;color:#111}.logo{display:block;max-width:110px;max-height:75px;object-fit:contain;margin:0 auto 10px}h2,p{text-align:center;margin:5px}#receipt-barcode{display:block;width:90%;height:65px;margin:10px auto}table{width:100%;border-collapse:collapse;margin:18px 0}td,th{padding:7px 2px;border-bottom:1px solid #ddd;text-align:left}td:last-child,th:last-child{text-align:right}.total{font-size:18px;font-weight:bold;text-align:right;margin-top:12px}.muted{font-size:11px;color:#555;text-align:center}@media print{button{display:none}}</style><script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\\/script></head><body>${logo}<h2>${escapeHtml(r.business_name || r.store_name)}</h2><p>${escapeHtml(r.store_name || '')}</p><p>${escapeHtml(r.store_location || '')}</p><p>${escapeHtml(r.business_phone || '')}</p><p>${escapeHtml(r.business_email || '')}</p><hr><p><b>RECEIPT</b></p><p>${escapeHtml(r.receipt_no)}</p><svg id="receipt-barcode"></svg><p>${new Date(r.issued_at).toLocaleString('en-KE')}</p><p>${escapeHtml(r.customer_name || 'Walk-in customer')} · ${escapeHtml(r.customer_phone || '')}</p><table><thead><tr><th>Item</th><th>Qty</th><th>Amount</th></tr></thead><tbody>${items}</tbody></table><p>Subtotal: KSh ${Number(r.subtotalKes).toLocaleString('en-KE',{minimumFractionDigits:2})}</p><p>Discount: KSh ${Number(r.discountKes).toLocaleString('en-KE',{minimumFractionDigits:2})}</p><p class="total">Total: KSh ${Number(r.totalKes).toLocaleString('en-KE',{minimumFractionDigits:2})}</p><p>Payment: ${escapeHtml(String(r.payment_method || '').toUpperCase())}</p><p class="muted">Thank you for shopping with us.</p><button onclick="window.print()">Print</button><script>if(window.JsBarcode){JsBarcode("#receipt-barcode",${JSON.stringify(String(r.receipt_no))},{format:"CODE128",displayValue:true,fontSize:12,margin:2});}</script></body></html>`;
    const win = window.open('', '_blank', 'width=480,height=720');
    if (!win) { message('Allow pop-ups to print this receipt.'); return; }
    win.document.open(); win.document.write(html); win.document.close(); win.focus();
  });
  function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
})();