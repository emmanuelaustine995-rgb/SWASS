(() => {
  'use strict';
  const api = (window.SWASS_API_URL || 'https://swass-api.onrender.com').replace(/\/$/, '');
  const $ = (id) => document.getElementById(id);
  let phone = '';
  let requestStarted = false;
  let recoveredReceipts = [];
  let apiWarmupPromise = null;
  async function warmApi() {
    if (apiWarmupPromise) return apiWarmupPromise;
    apiWarmupPromise = fetch(`${api}/health`, { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(65000) })
      .catch(() => null).finally(() => { apiWarmupPromise = null; });
    return apiWarmupPromise;
  }
  const message = (text) => { $('message').textContent = text; };
  async function readResponse(response) {
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
    if (!response.ok) throw new Error(data.message || `Request failed (${response.status})`);
    return data;
  }
  let countdownTimer = null;
  let secondsLeft = 0;
  function startResendCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    secondsLeft = 30;
    $('resend-area').innerHTML = 'You can resend a new code in <strong id="countdown">30</strong> seconds.';
    $('resend-button').disabled = true;
    countdownTimer = setInterval(() => {
      secondsLeft -= 1;
      const counter = $('countdown');
      if (counter) counter.textContent = String(secondsLeft);
      if (secondsLeft <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        $('resend-area').textContent = 'Did not receive the code?';
        $('resend-button').disabled = false;
      }
    }, 1000);
  }
  async function sendCode(isResend) {
    if (!phone) phone = $('phone').value.trim();
    if (!phone) { message('Enter the phone number used on the receipt.'); return; }
    requestStarted = true;
    $('verify-form').classList.remove('hidden');
    $('phone').readOnly = true;
    $('code').value = '';
    $('receipt-list').innerHTML = '';
    $('verify-submit').disabled = false;
    $('verify-submit').textContent = 'Verify and find receipts';
    $('resend-button').disabled = true;
    message('Connecting to SWASS server…');
    const sendButton = $('request-form').querySelector('button[type="submit"]');
    sendButton.disabled = true;
    sendButton.textContent = 'Connecting…';
    try {
      await warmApi();
      message(isResend ? 'Sending another verification code…' : 'Sending verification code…');
      sendButton.textContent = 'Sending code…';
      const r = await fetch(`${api}/api/v1/receipt-recovery/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      });
      const data = await readResponse(r);
      message(data.developmentCode ? 'Development test code: ' + data.developmentCode : 'The server accepted the OTP request. Enter the newest six-digit code when it arrives.');
      startResendCountdown();
      sendButton.textContent = 'OTP requested';
      $('code').focus();
    } catch (err) {
      requestStarted = false;
      sendButton.disabled = false;
      sendButton.textContent = 'Send verification code';
      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
      secondsLeft = 0;
      $('resend-area').textContent = '';
      $('resend-button').disabled = true;
      message(err.message || 'Could not send the verification code. Please try again.');
    }
  }
  $('request-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (requestStarted) return;
    await sendCode(false);
  });
  $('resend-button').addEventListener('click', async () => {
    if (secondsLeft > 0) return;
    await sendCode(true);
  });
  $('verify-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('code').value.replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) { message('Enter all six digits from the latest SMS.'); return; }
    const button = $('verify-submit');
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
      if (countdownTimer) clearInterval(countdownTimer);
      $('resend-area').textContent = '';
      $('resend-button').classList.add('hidden');
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
    const items = (r.items || []).map(item => `<tr><td><strong>${escapeHtml(item.name)}</strong>${item.serialNo ? `<div class="serial">IMEI / Serial: ${escapeHtml(item.serialNo)}</div>` : ''}</td><td>${Number(item.qty)}</td><td>KSh ${Number(item.unitPriceKes).toLocaleString('en-KE',{minimumFractionDigits:2})}</td><td>KSh ${Number(item.lineTotalKes).toLocaleString('en-KE',{minimumFractionDigits:2})}</td></tr>`).join('');
    const logo = r.logo_data ? `<img class="logo" src="${escapeHtml(r.logo_data)}" alt="Business logo">` : '';
    const verifyUrl = new URL(`verify.html?token=${encodeURIComponent(r.qr_token || '')}`, window.location.href).href;
    const issued = r.issued_at ? new Date(r.issued_at) : new Date();
    const cashier = r.cashier || {};
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Receipt ${escapeHtml(r.receipt_no)}</title>
<style>
*{box-sizing:border-box}body{font:13px/1.45 Arial,sans-serif;max-width:390px;margin:16px auto;padding:12px;color:#171717;background:#fff}
header{text-align:center;border-bottom:1px dashed #777;padding-bottom:12px}.logo{display:block;max-width:125px;max-height:85px;object-fit:contain;margin:0 auto 8px}
h1{font-size:20px;margin:5px 0;text-transform:uppercase}header p{margin:2px 0;color:#333}.tag{font-size:10px;letter-spacing:2px;font-weight:bold}
.meta{display:grid;grid-template-columns:1fr 1fr;gap:7px 12px;padding:12px 0;border-bottom:1px dashed #777}.field{overflow-wrap:anywhere}.field b{display:block;font-size:10px;color:#555;text-transform:uppercase}
h2{font-size:13px;margin:13px 0 7px;text-transform:uppercase}
table{width:100%;border-collapse:collapse;font-size:11px}th,td{padding:7px 3px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}th{font-size:10px;text-transform:uppercase}td:nth-child(2),th:nth-child(2){text-align:center}td:nth-child(n+3),th:nth-child(n+3){text-align:right}.serial{font-size:10px;margin-top:4px;overflow-wrap:anywhere;color:#444}
.totals{margin:12px 0 0 auto;width:75%}.totalrow{display:flex;justify-content:space-between;padding:4px 0}.grand{font-size:17px;font-weight:bold;border-top:1px solid #222;margin-top:5px;padding-top:8px}
.stamp{border:3px double #a32626;border-radius:50%;color:#a32626;width:126px;height:126px;margin:18px auto;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;transform:rotate(-7deg);font-weight:bold}.stamp strong{font-size:24px;border-top:2px solid #a32626;border-bottom:2px solid #a32626;padding:3px 8px;margin:5px}
.verify{text-align:center;border-top:1px dashed #777;padding-top:12px;margin-top:12px}.qr{width:124px;height:124px;margin:8px auto}.verify a{font-size:9px;overflow-wrap:anywhere;color:#222}.thanks{text-align:center;font-weight:bold;margin-top:12px}.muted{font-size:10px;color:#555;text-align:center}
.actions{display:flex;gap:8px;margin:14px 0}.actions button{flex:1;padding:11px;border:0;border-radius:7px;background:#176b4a;color:white;font-weight:bold}
@media print{body{margin:0 auto;padding:4mm;max-width:none}.actions{display:none}a{color:#000}}
</style></head><body>
<header>${logo}<h1>${escapeHtml(r.business_name || r.store_name || 'Business')}</h1><p>${escapeHtml(r.store_name || '')}</p><p>${escapeHtml(r.store_location || '')}</p><p>${r.business_phone ? 'Tel: '+escapeHtml(r.business_phone) : ''}</p><p>${r.business_email ? escapeHtml(r.business_email) : ''}</p><p class="tag">OFFICIAL SALES RECEIPT</p></header>
<div class="meta">
<div class="field"><b>Receipt number</b>${escapeHtml(r.receipt_no)}</div>
<div class="field"><b>Date & time purchased</b>${issued.toLocaleString('en-KE')}</div>
<div class="field"><b>Customer</b>${escapeHtml(r.customer_name || 'Walk-in customer')}</div>
<div class="field"><b>Customer phone</b>${escapeHtml(r.customer_phone || 'Not provided')}</div>
<div class="field"><b>Sales agent / Sold by</b>${escapeHtml(cashier.name || 'Staff')}</div>
<div class="field"><b>Agent phone</b>${escapeHtml(cashier.phone || 'Not available')}</div>
<div class="field"><b>Payment method</b>${escapeHtml(String(r.payment_method || '').toUpperCase())}</div>
<div class="field"><b>Receipt status</b>${escapeHtml(String(r.status || 'issued').toUpperCase())}</div>
</div>
<h2>Items purchased</h2><table><thead><tr><th>Product / IMEI</th><th>Qty</th><th>Unit price</th><th>Amount</th></tr></thead><tbody>${items || '<tr><td colspan="4">No item details available</td></tr>'}</tbody></table>
<div class="totals">
<div class="totalrow"><span>Subtotal</span><span>KSh ${Number(r.subtotalKes).toLocaleString('en-KE',{minimumFractionDigits:2})}</span></div>
<div class="totalrow"><span>Discount</span><span>KSh ${Number(r.discountKes).toLocaleString('en-KE',{minimumFractionDigits:2})}</span></div>
<div class="totalrow grand"><span>TOTAL</span><span>KSh ${Number(r.totalKes).toLocaleString('en-KE',{minimumFractionDigits:2})}</span></div>
</div>
<div class="stamp"><span>${escapeHtml(r.business_name || r.store_name || 'SWASS')}</span><strong>ISSUED</strong><small>${issued.toLocaleDateString('en-KE')}</small></div>
<div class="verify"><b>SCAN TO VERIFY THIS RECEIPT</b><div id="receipt-qr" class="qr"></div><a href="${escapeHtml(verifyUrl)}">${escapeHtml(verifyUrl)}</a></div>
<p class="thanks">Thank you for shopping with us!</p><p class="muted">Keep this receipt for your records. Receipt recovery is available through SWASS using your phone number and OTP.</p>
<div class="actions"><button onclick="window.print()">Print receipt</button><button onclick="window.close()">Close</button></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>if(window.QRCode){new QRCode(document.getElementById('receipt-qr'),{text:${JSON.stringify(verifyUrl)},width:124,height:124,correctLevel:QRCode.CorrectLevel.M});}</script>
</body></html>`;
    const win = window.open('', '_blank', 'width=480,height=820');
    if (!win) { message('Allow pop-ups to print this receipt.'); return; }
    win.document.open(); win.document.write(html); win.document.close(); win.focus();
  });
  function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
})();