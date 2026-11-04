(() => {
  const api = (window.SWASS_API_URL || 'http://localhost:3000').replace(/\/$/, '');
  const $ = (id) => document.getElementById(id);
  let phone = '';
  const message = (text) => { $('message').textContent = text; };
  $('request-form').addEventListener('submit', async (e) => {
    e.preventDefault(); phone = $('phone').value.trim(); message('Requesting code…');
    try {
      const r = await fetch(`${api}/api/v1/receipt-recovery/request`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone}) });
      const data = await r.json(); if (!r.ok) throw new Error(data.message || 'Could not request a code');
      $('verify-form').classList.remove('hidden'); message(data.developmentCode ? `Development test code: ${data.developmentCode}` : data.message);
    } catch (err) { message(err.message); }
  });
  $('verify-form').addEventListener('submit', async (e) => {
    e.preventDefault(); message('Verifying code…');
    try {
      const r = await fetch(`${api}/api/v1/receipt-recovery/verify`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone,code:$('code').value.trim()}) });
      const data = await r.json(); if (!r.ok) throw new Error(data.message || 'Verification failed');
      const list = await fetch(`${api}/api/v1/receipt-recovery/receipts`, { headers:{'X-Recovery-Token':data.recoveryToken} });
      const found = await list.json(); if (!list.ok) throw new Error(found.message || 'Could not load receipts');
      $('receipt-list').innerHTML = found.receipts.length ? found.receipts.map(r => `<article class="panel"><strong>${escapeHtml(r.receipt_no)}</strong><p>${escapeHtml(r.store_name)} · KSh ${Number(r.totalKes).toLocaleString('en-KE')} · ${escapeHtml(r.status)}</p><small>${new Date(r.issued_at).toLocaleString()}</small></article>`).join('') : '<p>No receipts were found.</p>';
      message('Phone verified. Your recent receipts are shown below. This recovery session expires in 10 minutes.');
    } catch (err) { message(err.message); }
  });
  function escapeHtml(v) { return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
})();
