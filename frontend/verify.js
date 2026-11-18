(async () => {
 const api=(window.SWASS_API_URL||'http://localhost:3000').replace(/\/$/,'');
 const token=new URLSearchParams(location.search).get('token');
 const el=document.getElementById('result');
 if(!token){el.textContent='No receipt verification token was supplied.';return;}
 try { const r=await fetch(`${api}/api/v1/receipts/verify/${encodeURIComponent(token)}`); const d=await r.json();
  el.textContent=d.valid ? `VALID RECEIPT · ${d.storeName} · ${d.receiptNo} · KSh ${Number(d.totalKes).toLocaleString('en-KE')} · ${new Date(d.issuedAt).toLocaleString()}` : `Receipt not valid: ${d.message || d.status || 'not found'}`;
 } catch { el.textContent='Could not verify this receipt. Please try again when online.'; }
})();
