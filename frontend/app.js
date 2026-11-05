(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = { token: null, role: null, products: [], cart: new Map(), receiptNo: 1, lastReceipt: null, profileLogoData: undefined };
  const API = (window.SWASS_API_URL || '').replace(/\/$/, '');
  const money = (n) => `KSh ${Number(n || 0).toLocaleString('en-KE')}`;
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random()*16|0; return (c==='x'?r:(r&3|8)).toString(16); }));
  async function request(path, options = {}) {
    const res = await fetch(`${API}${path}`, { ...options, headers: { 'Content-Type':'application/json', ...(state.token ? { Authorization:`Bearer ${state.token}` } : {}), ...(options.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
    return data;
  }
  function showNotice(message, error = false) { const el=$('notice'); el.textContent=message; el.classList.remove('hidden'); el.style.background=error?'#fff0ef':'#fff5e8'; el.style.color=error?'#a12b22':'#8a4b08'; }
  function hideNotice(){ $('notice').classList.add('hidden'); }
  function showLogin(){ $('login-view').classList.remove('hidden'); $('pos-view').classList.add('hidden'); $('logout-btn').classList.add('hidden'); $('dashboard-link').classList.add('hidden'); $('user-label').textContent=''; }
  function showPOS(){ $('login-view').classList.add('hidden'); $('pos-view').classList.remove('hidden'); $('logout-btn').classList.remove('hidden'); $('user-label').textContent=state.role ? state.role.replace('_',' ') : 'Staff'; $('add-product-btn').classList.toggle('hidden', !['owner','manager'].includes(state.role)); $('dashboard-link').classList.toggle('hidden', !['owner','manager'].includes(state.role)); $('profile-toggle').classList.toggle('hidden', state.role !== 'owner'); }
  async function loadReceiptHistory(){
    $('history-error').textContent='';$('history-list').innerHTML='<div class="empty">Loading receipts…</div>';
    const p=new URLSearchParams();const q=$('history-search').value.trim();const from=$('history-from').value;const to=$('history-to').value;
    if(q)p.set('q',q);if(from)p.set('from',from);if(to)p.set('to',to);p.set('limit','50');
    try{const d=await request('/api/v1/receipts?'+p.toString());const rows=d.receipts||[];
      if(!rows.length){$('history-list').innerHTML='<div class="empty">No receipts match your search.</div>';return;}
      $('history-list').innerHTML=rows.map(r=>'<article class="history-row"><div class="history-row-top"><strong>'+escapeHtml(r.receiptNo)+'</strong><strong>'+money(r.totalKes)+'</strong></div><div class="history-row-meta">'+escapeHtml(new Date(r.issuedAt).toLocaleString('en-KE'))+' · '+escapeHtml(r.status)+' · '+escapeHtml(String(r.paymentMethod||'').toUpperCase())+'</div><div class="history-row-meta">'+(r.customer?escapeHtml(r.customer.fullName)+' · '+escapeHtml(r.customer.phone):'Walk-in customer')+'</div><div class="history-row-items">'+(r.items||[]).map(i=>escapeHtml(i.name)+' × '+Number(i.qty)).join(' · ')+'</div></article>').join('');
    }catch(e){$('history-list').innerHTML='';$('history-error').textContent=e.message||'Could not load receipt history.';}
  }
  async function loadBusinessProfile(){const d=await request('/api/v1/business/profile');const p=d.profile||{};$('profile-business-name').value=p.businessName||'';$('profile-business-phone').value=p.businessPhone||'';$('profile-business-email').value=p.businessEmail||'';$('profile-store-name').value=p.storeName||'';$('profile-store-location').value=p.storeLocation||'';$('profile-receipt-header').value=p.receiptHeader||'';$('profile-receipt-footer').value=p.receiptFooter||'';state.profileLogoData=p.logoData||undefined;const img=$('logo-preview');if(state.profileLogoData){img.src=state.profileLogoData;img.classList.remove('hidden');}else{img.removeAttribute('src');img.classList.add('hidden');}}
  async function compressLogo(file){if(!file||!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('Choose PNG, JPG or WebP.');if(file.size>60000)throw new Error('Choose a logo smaller than 60 KB.');return await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error('Could not read logo.'));r.readAsDataURL(file);});}
  async function loadProducts(){
    const q=$('product-search').value.trim(); const low=$('low-stock').checked;
    const params=new URLSearchParams(); if(q) params.set('q',q); if(low) params.set('lowStock','true');
    $('product-list').innerHTML='<div class="empty">Loading products…</div>';
    try { const data=await request(`/api/v1/products?${params}`); state.products=data.products||[]; renderProducts(); }
    catch(e){ $('product-list').innerHTML=`<div class="empty">${escapeHtml(e.message)}</div>`; showNotice('Could not load products. Check the API address and your connection.',true); }
  }
  function renderProducts(){
    $('product-count').textContent=`${state.products.length} items`;
    if(!state.products.length){$('product-list').innerHTML='<div class="empty">No products found. Add products through the inventory manager first.</div>';return;}
    $('product-list').innerHTML=state.products.map(p=>{
      const stock=Number(p.stockQty); const stockClass=stock<=0?'out':stock<=Number(p.reorderLevel)?'low':'';
      return `<button class="product-card" data-add="${p.id}" type="button"><span class="product-name">${escapeHtml(p.name)}</span><span class="product-meta"><span class="price">${money(p.priceKes)}</span><span class="stock ${stockClass}">${stock} in stock</span></span>${p.sku?`<span class="stock">SKU: ${escapeHtml(p.sku)}</span>`:''}</button>`;
    }).join('');
  }
  function addToCart(id){ const p=state.products.find(x=>x.id===id); if(!p)return; const old=state.cart.get(id); state.cart.set(id,{product:p,qty:(old?.qty||0)+1}); renderCart(); }
  function changeQty(id,delta){const row=state.cart.get(id);if(!row)return;row.qty+=delta;if(row.qty<=0)state.cart.delete(id);renderCart();}
  function totals(){const subtotal=[...state.cart.values()].reduce((s,r)=>s+Number(r.product.priceKes)*r.qty,0);const discount=Math.max(0,Math.floor(Number($('discount').value)||0));return {subtotal,discount,total:Math.max(0,subtotal-discount)};}
  function renderCart(){
    const rows=[...state.cart.entries()]; $('cart-list').innerHTML=rows.length?rows.map(([id,r])=>`<div class="cart-row"><div><div class="cart-row-name">${escapeHtml(r.product.name)}</div><div class="cart-row-sub">${money(r.product.priceKes)} each · ${money(Number(r.product.priceKes)*r.qty)}</div></div><div class="qty-control"><button type="button" data-qty="${id}" data-delta="-1" aria-label="Decrease">−</button><span>${r.qty}</span><button type="button" data-qty="${id}" data-delta="1" aria-label="Increase">+</button></div></div>`).join(''):'<div class="empty">Your cart is empty.</div>';
    const t=totals(); $('subtotal').textContent=money(t.subtotal);$('total').textContent=money(t.total);$('checkout-open').disabled=!rows.length||t.total<0;
  }
  function openCheckout(){const items=[...state.cart.values()];const needsBuyer=items.some(r=>r.product.requiresBuyerId);$('buyer-id-wrap').classList.toggle('hidden',!needsBuyer);$('buyer-id-note').classList.toggle('hidden',!needsBuyer);$('checkout-total').textContent=money(totals().total);$('checkout-error').textContent='';$('checkout-modal').classList.remove('hidden');}
  function makeReceiptMarkup(receipt, sale, customer){
    const business=receipt.business||{};
    const lines=sale.items.map(i=>`<div class="receipt-line"><span>${escapeHtml(i.name)} × ${i.qty}</span><span>${money(i.price*i.qty)}</span></div>`).join('');
    const verifyUrl=new URL('verify.html',window.location.href).href+'?token='+encodeURIComponent(receipt.qrToken); const recoveryUrl=new URL('recover.html',window.location.href).href;
    return `<div class="receipt-center">${business.logoData?'<img class="receipt-logo" src="'+escapeHtml(business.logoData)+'" alt="Business logo">':''}<h2>${escapeHtml(business.name||'BUSINESS NAME')}</h2>
      ${business.storeName?`<div>${escapeHtml(business.storeName)}</div>`:''}
      ${business.location?`<div>${escapeHtml(business.location)}</div>`:''}
      ${business.phone?`<div>Tel: ${escapeHtml(business.phone)}</div>`:''}
      ${business.email?`<div>Email: ${escapeHtml(business.email)}</div>`:''}
      ${business.receiptHeader?`<div>${escapeHtml(business.receiptHeader)}</div>`:''}
      <div class="muted">OFFICIAL SALES RECEIPT</div></div>
      <div class="receipt-divider"></div><div>Receipt: <strong>${escapeHtml(receipt.receiptNo)}</strong></div>
      <div class="receipt-center"><svg id="receipt-barcode" aria-label="Receipt barcode"></svg></div>
      <div>Date: ${new Date().toLocaleString('en-KE')}</div><div>Payment: ${escapeHtml(sale.paymentMethod.toUpperCase())}</div>
      ${customer?`<div>Customer: ${escapeHtml(customer.fullName)}</div><div>Phone: ${escapeHtml(customer.phone)}</div>${customer.email?`<div>Email: ${escapeHtml(customer.email)}</div>`:''}`:''}
      <div class="receipt-divider"></div>${lines}<div class="receipt-divider"></div>
      <div class="receipt-line"><span>Subtotal</span><span>${money(sale.subtotal)}</span></div>
      <div class="receipt-line"><span>Discount</span><span>${money(sale.discount)}</span></div>
      <div class="receipt-line"><strong>TOTAL PAID</strong><strong>${money(receipt.totalKes)}</strong></div>
      <div class="receipt-divider"></div><div class="receipt-center">Thank you for shopping with us!
      ${business.receiptFooter?`<br>${escapeHtml(business.receiptFooter)}`:''}
      <br><small>Scan/check online: ${escapeHtml(verifyUrl)}</small><br><small>Lost this receipt? Recover it using your phone and OTP: ${escapeHtml(recoveryUrl)}</small></div>`;
  }
  async function completeSale(ev){
    ev.preventDefault(); const items=[...state.cart.values()]; if(!items.length)return;
    const t=totals(); const needsBuyer=items.some(r=>r.product.requiresBuyerId);
    const customer={fullName:$('buyer-name').value.trim(),phone:$('buyer-phone').value.trim(),email:$('buyer-email').value.trim(),nationalId:$('buyer-id').value.trim()};
    if((customer.fullName&&!customer.phone)||(!customer.fullName&&customer.phone)){ $('checkout-error').textContent='Enter both the customer full name and phone number, or leave both blank.';return; }
    if(needsBuyer&&(!customer.fullName||!customer.phone||!customer.nationalId)){ $('checkout-error').textContent='Enter the buyer full name, phone number and National ID for this item.';return; }
    const payload={clientUuid:uuid(),receiptNo:`SW-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(state.receiptNo++).padStart(5,'0')}`,paymentMethod:$('payment-method').value,discountKes:t.discount,items:items.map(r=>({productId:r.product.id,qty:r.qty}))};
    if(customer.fullName&&customer.phone)payload.customer=customer;
    const btn=$('complete-sale');btn.disabled=true;btn.textContent='Issuing receipt…';$('checkout-error').textContent='';
    try{
      const receipt=await request('/api/v1/receipts',{method:'POST',body:JSON.stringify(payload)});
      state.lastReceipt=receipt; const sale={items:items.map(r=>({name:r.product.name,qty:r.qty,price:Number(r.product.priceKes)})),subtotal:t.subtotal,discount:t.discount,paymentMethod:payload.paymentMethod};
      $('receipt-paper').innerHTML=makeReceiptMarkup(receipt,sale,payload.customer);if(window.JsBarcode){try{window.JsBarcode('#receipt-barcode',receipt.receiptNo,{format:'CODE128',displayValue:true,height:48,margin:4});}catch{}}$('checkout-modal').classList.add('hidden');$('receipt-modal').classList.remove('hidden');state.cart.clear();$('discount').value='0';$('checkout-form').reset();renderCart();await loadProducts();hideNotice();
    }catch(e){$('checkout-error').textContent=e.message;}
    finally{btn.disabled=false;btn.textContent='Issue receipt';}
  }
  $('add-product-btn').addEventListener('click',()=>{ $('product-form').reset(); $('product-error').textContent=''; $('product-modal').classList.remove('hidden'); });
  $('product-close').addEventListener('click',()=> $('product-modal').classList.add('hidden'));
  $('product-form').addEventListener('submit',async e=>{
    e.preventDefault(); $('product-error').textContent='';
    const btn=$('product-form').querySelector('button[type="submit"]'); btn.disabled=true; btn.textContent='Saving goods…';
    const payload={name:$('product-name').value.trim(),sku:$('product-sku').value.trim()||null,barcode:$('product-barcode').value.trim()||null,priceKes:Number($('product-price').value),costKes:$('product-cost').value===''?null:Number($('product-cost').value),stockQty:Number($('product-stock').value),reorderLevel:Number($('product-reorder').value),requiresBuyerId:$('product-buyer-id').checked};
    try{ await request('/api/v1/products',{method:'POST',body:JSON.stringify(payload)}); $('product-modal').classList.add('hidden'); showNotice('Goods saved to your shop inventory.'); await loadProducts(); }
    catch(err){$('product-error').textContent=err.message||'Could not save goods.';}
    finally{btn.disabled=false;btn.textContent='Save goods to inventory';}
  });
  $('show-register').addEventListener('click',()=>{ $('login-form').classList.add('hidden'); $('register-form').classList.remove('hidden'); $('register-error').textContent=''; });
  $('show-login').addEventListener('click',()=>{ $('register-form').classList.add('hidden'); $('login-form').classList.remove('hidden'); $('login-error').textContent=''; });
  $('register-form').addEventListener('submit',async e=>{
    e.preventDefault(); $('register-error').textContent='';
    const btn=$('register-form').querySelector('button[type="submit"]'); btn.disabled=true; btn.textContent='Creating account…';
    try {
      const data=await request('/api/v1/auth/register',{method:'POST',body:JSON.stringify({
        businessName:$('reg-business').value.trim(),storeName:$('reg-store').value.trim(),storeLocation:$('reg-location').value.trim(),
        fullName:$('reg-name').value.trim(),phone:$('reg-phone').value.trim(),
        email:$('reg-email').value.trim(),password:$('reg-password').value
      })});
      state.token=data.accessToken; const parts=state.token.split('.')[1];
      const claims=JSON.parse(atob(parts.replace(/-/g,'+').replace(/_/g,'/'))); state.role=claims.role;
      $('register-form').reset(); showPOS(); showNotice('Your business account is ready. Your 7-day free trial has started. Add your products to begin.',false); await loadProducts();
    } catch(err) { $('register-error').textContent=err.message||'Registration failed. Please try again.'; }
    finally { btn.disabled=false; btn.textContent='Create business account'; }
  });
  $('login-form').addEventListener('submit',async e=>{e.preventDefault();$('login-error').textContent='';try{const data=await request('/api/v1/auth/login',{method:'POST',body:JSON.stringify({phone:$('login-phone').value.trim(),password:$('login-password').value})});state.token=data.accessToken;const parts=state.token.split('.')[1];const claims=JSON.parse(atob(parts.replace(/-/g,'+').replace(/_/g,'/')));state.role=claims.role;showPOS();hideNotice();if(['owner','manager'].includes(state.role))await loadBusinessProfile();await loadProducts();}catch(err){$('login-error').textContent=err.message||'Sign-in failed.';}});
  $('history-toggle').addEventListener('click',async()=>{const box=$('history-content');const opening=box.classList.contains('hidden');box.classList.toggle('hidden');$('history-toggle').textContent=opening?'Close history':'Open history';if(opening)await loadReceiptHistory();});
  $('history-search-btn').addEventListener('click',loadReceiptHistory);
  $('history-search').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();loadReceiptHistory();}});
  $('profile-toggle').addEventListener('click',async()=>{try{$('profile-error').textContent='';await loadBusinessProfile();$('profile-panel').classList.remove('hidden');$('profile-panel').scrollIntoView({behavior:'smooth',block:'start'});}catch(e){showNotice(e.message||'Could not load business profile.',true);}});
  $('profile-close').addEventListener('click',()=>$('profile-panel').classList.add('hidden'));
  $('business-logo').addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;try{state.profileLogoData=await compressLogo(file);$('logo-preview').src=state.profileLogoData;$('logo-preview').classList.remove('hidden');$('profile-error').textContent='';}catch(err){e.target.value='';$('profile-error').textContent=err.message;}});
  $('profile-form').addEventListener('submit',async e=>{e.preventDefault();const btn=$('profile-form').querySelector('button[type="submit"]');btn.disabled=true;btn.textContent='Saving…';$('profile-error').textContent='';const payload={businessName:$('profile-business-name').value.trim(),businessPhone:$('profile-business-phone').value.trim(),businessEmail:$('profile-business-email').value.trim()||null,storeName:$('profile-store-name').value.trim(),storeLocation:$('profile-store-location').value.trim()||null,receiptHeader:$('profile-receipt-header').value.trim()||null,receiptFooter:$('profile-receipt-footer').value.trim()||null};if(state.profileLogoData!==undefined)payload.logoData=state.profileLogoData;try{await request('/api/v1/business/profile',{method:'PATCH',body:JSON.stringify(payload)});showNotice('Business profile saved. Your logo and details will appear on new receipts.');$('profile-panel').classList.add('hidden');}catch(err){$('profile-error').textContent=err.message||'Could not save business profile.';}finally{btn.disabled=false;btn.textContent='Save business profile';}});
  $('logout-btn').addEventListener('click',()=>{state.token=null;state.role=null;state.cart.clear();renderCart();$('profile-panel').classList.add('hidden');showLogin();});
  $('product-list').addEventListener('click',e=>{const b=e.target.closest('[data-add]');if(b)addToCart(b.dataset.add);});
  $('cart-list').addEventListener('click',e=>{const b=e.target.closest('[data-qty]');if(b)changeQty(b.dataset.qty,Number(b.dataset.delta));});
  $('product-search').addEventListener('input',()=>loadProducts());$('low-stock').addEventListener('change',()=>loadProducts());$('refresh-btn').addEventListener('click',loadProducts);
  $('discount').addEventListener('input',renderCart);$('clear-cart').addEventListener('click',()=>{state.cart.clear();$('discount').value='0';renderCart();});
  $('checkout-open').addEventListener('click',openCheckout);$('checkout-close').addEventListener('click',()=>$('checkout-modal').classList.add('hidden'));$('checkout-form').addEventListener('submit',completeSale);
  $('receipt-close').addEventListener('click',()=>$('receipt-modal').classList.add('hidden'));$('new-sale').addEventListener('click',()=>$('receipt-modal').classList.add('hidden'));$('print-receipt').addEventListener('click',()=>window.print());
  const shareBtn=$('share-receipt'); if(shareBtn) shareBtn.addEventListener('click', async()=>{ if(!state.lastReceipt)return; const verifyUrl=new URL('verify.html',window.location.href).href+'?token='+encodeURIComponent(state.lastReceipt.qrToken); const text=`SWASS receipt ${state.lastReceipt.receiptNo} · KSh ${Number(state.lastReceipt.totalKes).toLocaleString('en-KE')} · Verify: ${verifyUrl}`; try { if(navigator.share) await navigator.share({title:'SWASS receipt',text}); else if(navigator.clipboard) { await navigator.clipboard.writeText(text); alert('Receipt summary copied.'); } } catch {} });
  // API URL is configurable without rebuilding: set window.SWASS_API_URL before app.js.
  if(!API){ showNotice('API address is not configured yet. Set SWASS_API_URL in frontend/config.js to your running API URL.',true); }
  showLogin(); renderCart();
})();
