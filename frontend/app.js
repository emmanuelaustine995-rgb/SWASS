(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = { token: null, role: null, products: [], cart: new Map(), receiptNo: 1, lastReceipt: null };
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
  function showLogin(){ $('login-view').classList.remove('hidden'); $('pos-view').classList.add('hidden'); $('logout-btn').classList.add('hidden'); $('user-label').textContent=''; }
  function showPOS(){ $('login-view').classList.add('hidden'); $('pos-view').classList.remove('hidden'); $('logout-btn').classList.remove('hidden'); $('user-label').textContent=state.role ? state.role.replace('_',' ') : 'Staff'; }
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
  function openCheckout(){const items=[...state.cart.values()];const needsBuyer=items.some(r=>r.product.requiresBuyerId);$('buyer-fields').classList.toggle('hidden',!needsBuyer);$('checkout-total').textContent=money(totals().total);$('checkout-error').textContent='';$('checkout-modal').classList.remove('hidden');}
  function makeReceiptMarkup(receipt, sale, customer){
    const lines=sale.items.map(i=>`<div class="receipt-line"><span>${escapeHtml(i.name)} × ${i.qty}</span><span>${money(i.price*i.qty)}</span></div>`).join('');
    return `<div class="receipt-center"><h3>SWASS BUSINESS</h3><div class="muted">Sales receipt</div></div><div class="receipt-divider"></div><div>Receipt: ${escapeHtml(receipt.receiptNo)}</div><div>Date: ${new Date().toLocaleString('en-KE')}</div><div>Payment: ${escapeHtml(sale.paymentMethod.toUpperCase())}</div>${customer?`<div>Buyer: ${escapeHtml(customer.fullName)}</div>`:''}<div class="receipt-divider"></div>${lines}<div class="receipt-divider"></div><div class="receipt-line"><span>Subtotal</span><span>${money(sale.subtotal)}</span></div><div class="receipt-line"><span>Discount</span><span>${money(sale.discount)}</span></div><div class="receipt-line"><strong>TOTAL</strong><strong>${money(receipt.totalKes)}</strong></div><div class="receipt-divider"></div><div class="receipt-center">Thank you for shopping with us!<br><small>Receipt reference: ${escapeHtml(receipt.id)}</small><br><small>Verify online: ${escapeHtml((new URL('verify.html', window.location.href).href + '?token=' + encodeURIComponent(receipt.qrToken)))}</small></div>`;
  }
  async function completeSale(ev){
    ev.preventDefault(); const items=[...state.cart.values()]; if(!items.length)return;
    const t=totals(); const needsBuyer=items.some(r=>r.product.requiresBuyerId);
    const customer={fullName:$('buyer-name').value.trim(),phone:$('buyer-phone').value.trim(),nationalId:$('buyer-id').value.trim()};
    if(needsBuyer&&(!customer.fullName||!customer.phone||!customer.nationalId)){ $('checkout-error').textContent='Enter the buyer full name, phone number and National ID for this item.';return; }
    const payload={clientUuid:uuid(),receiptNo:`SW-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(state.receiptNo++).padStart(5,'0')}`,paymentMethod:$('payment-method').value,discountKes:t.discount,items:items.map(r=>({productId:r.product.id,qty:r.qty}))};
    if(customer.fullName&&customer.phone)payload.customer=customer;
    const btn=$('complete-sale');btn.disabled=true;btn.textContent='Issuing receipt…';$('checkout-error').textContent='';
    try{
      const receipt=await request('/api/v1/receipts',{method:'POST',body:JSON.stringify(payload)});
      state.lastReceipt=receipt; const sale={items:items.map(r=>({name:r.product.name,qty:r.qty,price:Number(r.product.priceKes)})),subtotal:t.subtotal,discount:t.discount,paymentMethod:payload.paymentMethod};
      $('receipt-paper').innerHTML=makeReceiptMarkup(receipt,sale,payload.customer);$('checkout-modal').classList.add('hidden');$('receipt-modal').classList.remove('hidden');state.cart.clear();$('discount').value='0';$('checkout-form').reset();renderCart();await loadProducts();hideNotice();
    }catch(e){$('checkout-error').textContent=e.message;}
    finally{btn.disabled=false;btn.textContent='Issue receipt';}
  }
  $('login-form').addEventListener('submit',async e=>{e.preventDefault();$('login-error').textContent='';try{const data=await request('/api/v1/auth/login',{method:'POST',body:JSON.stringify({phone:$('login-phone').value.trim(),password:$('login-password').value})});state.token=data.accessToken;const parts=state.token.split('.')[1];const claims=JSON.parse(atob(parts.replace(/-/g,'+').replace(/_/g,'/')));state.role=claims.role;showPOS();hideNotice();await loadProducts();}catch(err){$('login-error').textContent=err.message||'Sign-in failed.';}});
  $('logout-btn').addEventListener('click',()=>{state.token=null;state.role=null;state.cart.clear();renderCart();showLogin();});
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
