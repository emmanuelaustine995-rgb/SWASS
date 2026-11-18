(() => {
  'use strict';
  const api=(window.SWASS_API_URL||'https://swass-api.onrender.com').replace(/\/$/,'');
  const $=id=>document.getElementById(id);
  let recoveryToken='';
  const message=value=>{$('special-message').textContent=value;};
  async function readResponse(response){const raw=await response.text();let data={};try{data=raw?JSON.parse(raw):{};}catch{}if(!response.ok)throw new Error(data.message||'Request failed ('+response.status+')');return data;}
  $('special-request-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=$('special-request-button');
    const nationalId=$('special-national-id').value.trim(),phone=$('special-phone').value.trim();
    if(!nationalId||!phone){message('Enter the seller National ID and phone number.');return;}
    button.disabled=true;button.textContent='Connecting to M-Pesa…';$('special-receipt-list').innerHTML='';
    try{
      await fetch(api+'/health',{cache:'no-store',signal:AbortSignal.timeout(65000)}).catch(()=>null);
      const response=await fetch(api+'/api/v1/second-hand-special-recovery/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nationalId,phone})});
      const data=await readResponse(response);recoveryToken=data.recoveryToken;
      message('M-Pesa prompt requested for KSh 50. Enter your M-Pesa PIN, then wait for confirmation.');
      button.textContent='Waiting for KSh 50 payment…';await pollPayment(data.paymentId);
    }catch(error){message(error.message||'Could not start Special Receipt recovery.');button.disabled=false;button.textContent='Pay KSh 50 and recover receipt';}
  });
  async function pollPayment(paymentId){
    const started=Date.now();
    while(Date.now()-started<120000){
      await new Promise(resolve=>setTimeout(resolve,2500));
      const response=await fetch(api+'/api/v1/second-hand-special-recovery/status/'+encodeURIComponent(paymentId),{headers:{'X-Recovery-Token':recoveryToken},cache:'no-store'});
      const data=await readResponse(response);
      if(data.status==='success'){message('KSh 50 payment confirmed. Loading your saved receipt…');await loadDeclaration();return;}
      if(data.status==='failed')throw new Error('M-Pesa payment was not completed. Please try again.');
      message('Waiting for M-Pesa payment confirmation…');
    }
    throw new Error('Payment is still pending. Do not pay again yet. Refresh later and check before retrying.');
  }
  const money=value=>Number(value||0).toLocaleString('en-KE',{minimumFractionDigits:2});
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function loadDeclaration(){
    const response=await fetch(api+'/api/v1/second-hand-special-recovery/declaration',{headers:{'X-Recovery-Token':recoveryToken},cache:'no-store'});
    const data=await readResponse(response),d=data.declaration||{};
    const fields=[['Seller full name',d.sellerName],['National ID',d.nationalId],['Seller phone',d.sellerPhone],['Alternative phone',d.alternativePhone],['Residential address',d.residentialAddress],['Goods / make and model',d.productName],['IMEI / identifier',d.imei1],['Second IMEI',d.imei2],['Serial number',d.serialNumber],['Condition',d.condition],['Agreed purchase price','KSh '+money(d.purchasePriceKes)],['Original receipt status',d.receiptStatus],['Witness',d.witnessName],['Witness phone',d.witnessPhone],['Declaration accepted','Yes'],['Shop acknowledgement',d.shopAcknowledged?'Yes':'No'],['Date recorded',d.createdAt?new Date(d.createdAt).toLocaleString('en-KE'):'']];
    $('special-receipt-list').innerHTML='<article class="panel recovered-receipt"><h2>Second-Hand Goods Special Receipt</h2><p><strong>Reference:</strong> '+esc(d.declarationRef||'')+'</p>'+fields.map(([label,value])=>value?'<p><strong>'+esc(label)+':</strong> '+esc(value)+'</p>':'').join('')+'<p><button type="button" id="print-special-receipt">Print / Save PDF</button></p></article>';
    $('print-special-receipt').addEventListener('click',()=>{
      const win=window.open('','_blank','width=520,height=800');if(!win){message('Allow pop-ups to print this receipt.');return;}
      win.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Special Receipt '+esc(d.declarationRef||'')+'</title><style>body{font:14px Arial;max-width:620px;margin:24px auto;color:#111}h1,h2{text-align:center}p{padding:7px 0;border-bottom:1px solid #ddd}.notice{border:1px solid #555;padding:12px;margin-top:18px}@media print{button{display:none}}</style></head><body><h1>AURORA E-RECEIPT</h1><h2>SECOND-HAND GOODS SPECIAL RECEIPT</h2><p><b>Reference:</b> '+esc(d.declarationRef||'')+'</p>'+fields.map(([label,value])=>value?'<p><b>'+esc(label)+':</b> '+esc(value)+'</p>':'').join('')+'<div class="notice">This document records the seller declaration and shop acknowledgement stored at the time of signing. It is a record of the declaration, not a guarantee of legal outcome.</div><p style="text-align:center"><button onclick="window.print()">Print / Save PDF</button></p></body></html>');
      win.document.close();win.focus();
    });
    message('Payment confirmed. Your saved Second-Hand Goods Special Receipt is unlocked.');
    $('special-request-button').disabled=false;$('special-request-button').textContent='Recover another receipt';
  }
})();