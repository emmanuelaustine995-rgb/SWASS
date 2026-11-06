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
        <div class="history-row-top"><strong>${escapeHtml(r.receipt_no)}</strong><strong>KSh ${Number(r.totalKes).toLocaleString('en-KE',{minimumFractionDigits:2})}</strong></div>
        <p>${escapeHtml(r.business_name || r.store_name || '')} · ${escapeHtml(r.store_name || '')}</p>
        <p>${escapeHtml(r.customer_name || 'Customer')} · ${escapeHtml(r.customer_phone || '')}</p>
        <p>${new Date(r.issued_at).toLocaleString('en-KE')} · ${escapeHtml(String(r.status || 'issued'))}</p>
        <p>${(r.items || []).map(item => escapeHtml(item.name) + ' × ' + Number(item.qty)).join(', ')}</p>
        <button type="button" class="print-recovered" data-index="${index}">Print / Save PDF</button>
      </article>`).join('');
    message('Payment confirmed. All ' + receipts.length + ' matching receipts are now unlocked. You can print or save each one as PDF.');
  }
  $('receipt-list').addEventListener('click', (event) => {
    const button = event.target.closest('.print-recovered');
    if (!button) return;
    const r = receipts[Number(button.dataset.index)];
    if (!r) return;
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
})();