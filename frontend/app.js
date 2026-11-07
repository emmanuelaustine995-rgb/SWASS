(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = { token: null, role: null, userName: '', staffTitle: '', userPhotoData: '', products: [], cart: new Map(), lastReceipt: null, profileLogoData: undefined, businessProfile: {} };
  const SESSION_KEY = 'swass-auth-session-v1';
  const SESSION_IDLE_MS = 3 * 60 * 60 * 1000;
  let lastSessionWrite = 0;
  function saveSession(){ if(!state.token)return; const now=Date.now(); localStorage.setItem(SESSION_KEY,JSON.stringify({token:state.token,role:state.role,userName:state.userName,staffTitle:state.staffTitle,userPhotoData:state.userPhotoData,lastActivity:now})); lastSessionWrite=now; }
  function touchSession(){ if(!state.token)return; const now=Date.now(); if(now-lastSessionWrite<30000)return; try{const saved=JSON.parse(localStorage.getItem(SESSION_KEY)||'null');if(saved?.token===state.token){saved.lastActivity=now;localStorage.setItem(SESSION_KEY,JSON.stringify(saved));lastSessionWrite=now;}}catch{localStorage.removeItem(SESSION_KEY);} }
  function clearSession(){ localStorage.removeItem(SESSION_KEY); state.token=null; state.role=null; }
  function sessionIsValid(saved){ if(!saved?.token||!Number.isFinite(saved.lastActivity)||Date.now()-saved.lastActivity>SESSION_IDLE_MS)return false; try{const part=saved.token.split('.')[1];const claims=JSON.parse(atob(part.replace(/-/g,'+').replace(/_/g,'/')));return !!claims.exp&&claims.exp*1000>Date.now();}catch{return false;} }
  async function restoreSession(){
    let saved;try{saved=JSON.parse(localStorage.getItem(SESSION_KEY)||'null');}catch{}
    if(!sessionIsValid(saved)){clearSession();showLogin();return;}
    state.token=saved.token;state.role=saved.role||'owner';state.userName=saved.userName||'';state.staffTitle=saved.staffTitle||'';state.userPhotoData=saved.userPhotoData||'';lastSessionWrite=Number(saved.lastActivity)||Date.now();
    showPOS();publishWorkspaceSession();
    let subscriptionRequired=false;
    try{if(['owner','manager'].includes(state.role))await loadBusinessProfile();await loadProducts();}
    catch(error){
      if(error.status===402) subscriptionRequired=true;
      else showNotice('You are signed in, but some business data could not load. '+(error.message||''),true);
    }
    if(['owner','manager'].includes(state.role)){
      let selected='dashboard';try{const candidate=localStorage.getItem('swass-active-workspace-v1');if(['dashboard','operations','receipts','crm','accounting'].includes(candidate))selected=candidate;}catch{}
      if(subscriptionRequired) selected='accounting';
      showWorkspaceScreen(selected);
      if(subscriptionRequired) showNotice('SWASS is locked until you subscribe. Pay KSh 100 for one month or KSh 900 for one year, then add receipt credits at KSh 2 each.');
    } else if(state.role === 'cashier') {
      showWorkspaceScreen('receipts');
    } else {
      showWorkspaceScreen('dashboard');
    }
  }
  function checkSessionExpiry(){ if(!state.token)return; let saved;try{saved=JSON.parse(localStorage.getItem(SESSION_KEY)||'null');}catch{} if(!sessionIsValid(saved)){clearSession();window.dispatchEvent(new Event('swass:logout'));state.cart.clear();renderCart();showLogin();showNotice('Your session ended after 3 hours without activity. Please sign in again.');} }
  const API = (window.SWASS_API_URL || '').replace(/\/$/, '');
  // Warm the free Render API while the visitor is reading the page. This
  // reduces the chance that signup is the first request after the service sleeps.
  let apiWarmupPromise = null;
  async function warmApi() {
    if (!API || document.visibilityState === 'hidden' || apiWarmupPromise) return apiWarmupPromise;
    apiWarmupPromise = fetch(`${API}/health`, { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(65000) })
      .catch(() => null)
      .finally(() => { apiWarmupPromise = null; });
    return apiWarmupPromise;
  }
  void warmApi();
  window.addEventListener('focus', () => { void warmApi(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void warmApi();
  });
  // Render's free service sleeps after inactivity; keep an actively open
  // SWASS tab warm without sending frequent requests.
  window.setInterval(() => {
    if (document.visibilityState === 'visible') void warmApi();
  }, 10 * 60 * 1000);
  const money = (n) => `KSh ${Number(n || 0).toLocaleString('en-KE')}`;
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random()*16|0; return (c==='x'?r:(r&3|8)).toString(16); }));
  async function request(path, options = {}) {
    touchSession();
    const res = await fetch(`${API}${path}`, { ...options, headers: { 'Content-Type':'application/json', ...(state.token ? { Authorization:`Bearer ${state.token}` } : {}), ...(options.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.message || `Request failed (${res.status})`);
      error.status = res.status;
      throw error;
    }
    return data;
  }
  function publishWorkspaceSession(){saveSession();window.dispatchEvent(new CustomEvent('swass:login',{detail:{token:state.token,role:state.role}}));}
  function showNotice(message, error = false) { const el=$('notice'); el.textContent=message; el.classList.remove('hidden'); el.style.background=error?'#fff0ef':'#fff5e8'; el.style.color=error?'#a12b22':'#8a4b08'; }
  function hideNotice(){ $('notice').classList.add('hidden'); }
  function showLogin(){ $('welcome-back-banner')?.classList.add('hidden'); $('login-view').classList.remove('hidden'); $('pos-view').classList.add('hidden'); $('logout-btn').classList.add('hidden'); $('dashboard-link').classList.add('hidden'); $('workspace-nav').classList.add('hidden'); $('user-label').textContent=''; }

  function renderDashboardBusinessProfile(){
    const p=state.businessProfile||{};
    const complete=!!(String(p.businessName||'').trim()&&String(p.businessPhone||'').trim()&&String(p.storeName||'').trim());
    const card=$('dashboard-business-card'),panel=$('profile-panel'),close=$('profile-close'),button=$('dashboard-edit-profile');
    if(!card||!panel)return;
    card.classList.remove('hidden');
    $('dashboard-profile-name').textContent=complete?p.businessName:'Complete your business profile';
    $('dashboard-profile-meta').textContent=complete?[p.storeName,p.businessPhone,p.storeLocation].filter(Boolean).join(' · '):'Add your business name, phone and branch details to set up SWASS.';
    const photo=$('dashboard-profile-image');
    if(p.logoData){photo.src=p.logoData;photo.classList.remove('hidden');}else{photo.removeAttribute('src');photo.classList.add('hidden');}
    button.textContent=complete?'Update business profile':'Complete business profile';
    close.classList.toggle('hidden',!complete);
    panel.classList.toggle('hidden',complete);
  }
  function showWorkspaceScreen(screen){
    try{localStorage.setItem('swass-active-workspace-v1',screen);}catch{}
    const owner=document.getElementById('owner-dashboard-view'),pos=$('pos-view');
    const products=document.getElementById('products-panel');
    const cart=document.querySelector('.cart-panel');
    const posGrid=document.querySelector('.pos-grid');
    const history=document.getElementById('history-panel');
    const crm=document.getElementById('owner-customers-section');
    const lookup=document.querySelector('.customer-lookup-panel');
    const profile=document.getElementById('profile-panel');
    const receiptHome=document.getElementById('receipts-home');
    if(!owner||!pos)return;
    [history,crm,lookup,receiptHome].forEach(el=>el?.classList.add('hidden'));
    profile?.classList.add('hidden');
    $('dashboard-business-card')?.classList.toggle('hidden',screen!=='dashboard');
    owner.classList.add('hidden');
    owner.classList.remove('workspace-dashboard','workspace-accounting','workspace-console');
    pos.classList.remove('workspace-logistics','workspace-issue-mode');
    posGrid?.classList.add('hidden');
    products?.classList.remove('hidden');
    cart?.classList.remove('hidden');
    if(screen==='dashboard'){
      pos.classList.remove('hidden');owner.classList.remove('hidden');
      if(state.role==='owner')void loadStaffInvitations();
      owner.classList.add('workspace-dashboard');
      renderDashboardBusinessProfile();
      owner.querySelector('#owner-period-comparison')?.scrollIntoView({block:'start'});
    }else if(screen==='operations'){
      pos.classList.remove('hidden');
      posGrid?.classList.remove('hidden');
      owner.classList.remove('hidden');
      owner.classList.add('workspace-console');
      pos.scrollIntoView({block:'start'});
    }else if(screen==='receipts'){
      pos.classList.add('hidden');
      receiptHome?.classList.remove('hidden');
      $('open-recover-receipt')?.classList.toggle('hidden',state.role==='cashier');
      receiptHome?.scrollIntoView({block:'start'});
    }else if(screen==='accounting'){
      pos.classList.remove('hidden');owner.classList.remove('hidden');
      owner.classList.add('workspace-accounting');
      document.getElementById('owner-payments-section')?.scrollIntoView({block:'start'});
    }
    document.querySelectorAll('#workspace-nav button').forEach(b=>b.classList.toggle('active',b.dataset.workspace===screen));
  }

  function showPOS(){ $('login-view').classList.add('hidden'); $('pos-view').classList.remove('hidden'); const welcome=$('welcome-back-banner'); if(welcome){const hour=new Date().getHours();const greeting=hour<12?'Good morning':hour<17?'Good afternoon':'Good evening';welcome.textContent=`${greeting}, welcome back${state.userName?' '+state.userName:''}!`;welcome.classList.remove('hidden');} $('logout-btn').classList.remove('hidden'); const label=$('user-label');label.textContent=state.staffTitle||(state.role==='cashier'?'Shop Attendant':state.role?state.role.replace('_',' '):'Staff');if(state.userPhotoData){const avatar=document.createElement('img');avatar.src=state.userPhotoData;avatar.alt='Staff profile photo';avatar.style.cssText='width:30px;height:30px;object-fit:cover;border-radius:50%;vertical-align:middle;margin-right:8px';label.prepend(avatar);} $('add-product-btn').classList.toggle('hidden', !['owner','manager'].includes(state.role)); $('dashboard-link').classList.toggle('hidden', !['owner','manager'].includes(state.role));$('workspace-nav').classList.toggle('hidden', !['owner','manager'].includes(state.role));  }
  async function lookupCustomer(ev){
    ev.preventDefault();
    const phone=$('lookup-phone').value.trim();
    const nationalId=$('lookup-national-id').value.trim();
    const message=$('customer-lookup-message');
    const result=$('customer-lookup-result');
    message.textContent='Searching customer records…';result.innerHTML='';
    try{
      const data=await request('/api/v1/customers/lookup',{method:'POST',body:JSON.stringify({phone,nationalId})});
      if(!data.found){
        message.textContent='No matching customer was found. Register the customer to continue.';
        result.innerHTML='<div class="customer-result"><p><strong>New customer</strong></p><p class="muted small">Enter the customer details at checkout, then issue the first receipt to save their customer record.</p><button type="button" id="register-lookup-customer" class="btn btn-light">Register new customer</button></div>';
        return;
      }
      const c=data.customer;
      $('buyer-name').value=c.fullName||'';$('buyer-phone').value=c.phone||'';
      $('buyer-email').value=c.email||'';
      $('buyer-id').value=nationalId;
      message.textContent='Customer found. Their details have been added to the next sale.';
      const history=(data.recentReceipts||[]).map(r=>'<li>'+escapeHtml(r.receiptNo)+' · '+money(r.totalKes)+' · '+escapeHtml(new Date(r.issuedAt).toLocaleDateString('en-KE'))+'</li>').join('');
      result.innerHTML='<div class="customer-result"><div class="customer-result-head"><strong>'+escapeHtml(c.fullName)+'</strong><span class="customer-match">Verified match</span></div><p>Phone: '+escapeHtml(c.phone)+'</p><p>National ID: •••• '+escapeHtml(c.nationalIdLast4||'')+'</p><p>Previous purchases: '+Number(c.purchaseCount||0)+' · Loyalty points: '+Number(c.loyaltyPoints||0)+'</p><p>Lifetime spend: '+money(c.lifetimeSpendKes)+'</p>'+(history?'<strong>Recent receipts</strong><ul>'+history+'</ul>':'<p class="muted small">No previous receipts in this branch.</p>')+'<button type="button" id="add-customer-package" class="btn btn-primary">Add New Package</button></div>';
    }catch(e){message.textContent=e.message||'Could not find customer.';}
  }
  async function loadReceiptHistory(){
    $('history-error').textContent='';$('history-list').innerHTML='<div class="empty">Loading receipts…</div>';
    const p=new URLSearchParams();const q=$('history-search').value.trim();const from=$('history-from').value;const to=$('history-to').value;
    if(q)p.set('q',q);if(from)p.set('from',from);if(to)p.set('to',to);p.set('limit','50');
    try{const d=await request('/api/v1/receipts?'+p.toString());const rows=d.receipts||[];
      if(!rows.length){$('history-list').innerHTML='<div class="empty">No receipts match your search.</div>';return;}
      $('history-list').innerHTML=rows.map(r=>'<article class="history-row"><div class="history-row-top"><strong>'+escapeHtml(r.receiptNo)+'</strong><strong>'+money(r.totalKes)+'</strong></div><div class="history-row-meta">'+escapeHtml(new Date(r.issuedAt).toLocaleString('en-KE'))+' · '+escapeHtml(r.status)+' · '+escapeHtml(String(r.paymentMethod||'').toUpperCase())+'</div><div class="history-row-meta">Sales agent: '+escapeHtml(r.cashier?.name||'Staff')+'</div><div class="history-row-meta">PDF delivery · Email: '+escapeHtml(r.delivery?.email||'not requested')+' · WhatsApp: '+escapeHtml(r.delivery?.whatsapp||'not requested')+'</div><div class="history-row-meta">'+(r.customer?escapeHtml(r.customer.fullName)+' · '+escapeHtml(r.customer.phone)+(r.customer.nationalIdLast4?' · ID ending '+escapeHtml(r.customer.nationalIdLast4):''):'Walk-in customer')+'</div><div class="history-row-items">'+(r.items||[]).map(i=>escapeHtml(i.name)+' × '+Number(i.qty)+(i.serialNo?' · IMEI: '+escapeHtml(i.serialNo):'')).join(' · ')+'</div></article>').join('');
    }catch(e){$('history-list').innerHTML='';$('history-error').textContent=e.message||'Could not load receipt history.';}
  }
  async function loadBusinessProfile(){const d=await request('/api/v1/business/profile');const p=d.profile||{};state.businessProfile=p;if(!state.userName){state.userName=p.ownerFullName||p.ownerName||p.fullName||p.name||'';if(state.userName)saveSession();}$('profile-business-name').value=p.businessName||'';$('profile-business-phone').value=p.businessPhone||'';$('profile-business-email').value=p.businessEmail||'';$('profile-store-name').value=p.storeName||'';$('profile-store-location').value=p.storeLocation||'';$('profile-receipt-header').value=p.receiptHeader||'';$('profile-receipt-footer').value=p.receiptFooter||'';state.profileLogoData=p.logoData||undefined;const img=$('logo-preview');if(state.profileLogoData){img.src=state.profileLogoData;img.classList.remove('hidden');}else{img.removeAttribute('src');img.classList.add('hidden');}}
  async function compressLogo(file){
    if(!file||!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('Choose PNG, JPG or WebP.');
    let bitmap;
    try{bitmap=await createImageBitmap(file);}catch{throw new Error('This image could not be opened. Please choose another PNG, JPG or WebP image.');}
    try{
      let width=bitmap.width,height=bitmap.height;
      const maxSide=640;
      if(width>maxSide||height>maxSide){const scale=Math.min(maxSide/width,maxSide/height);width=Math.max(1,Math.round(width*scale));height=Math.max(1,Math.round(height*scale));}
      const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
      const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Your browser could not prepare the logo.');
      ctx.fillStyle='#ffffff';ctx.fillRect(0,0,width,height);ctx.drawImage(bitmap,0,0,width,height);
      let blob=null;
      for(let pass=0;pass<7;pass++){
        const quality=[0.82,0.72,0.62,0.52,0.42,0.32,0.25][pass];
        blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
        if(blob&&blob.size<=45000)break;
        if(pass===2){canvas.width=Math.max(1,Math.round(canvas.width*0.8));canvas.height=Math.max(1,Math.round(canvas.height*0.8));ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);}
      }
      if(!blob||blob.size>45000)throw new Error('This logo is too detailed to reduce. Please choose a simpler image.');
      return await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Could not prepare the logo.'));reader.readAsDataURL(blob);});
    }finally{bitmap.close?.();}
  }
  async function loadStaffInvitations(){
    const list=$('staff-invitations-list');if(!list)return;
    list.innerHTML='<div class="empty">Loading invitations…</div>';
    try{
      const data=await request('/api/v1/staff/invitations');const rows=data.invitations||[];
      if(!rows.length){list.innerHTML='<div class="empty">No staff invitations yet.</div>';return;}
      list.innerHTML=rows.map(i=>{
        const status=i.accepted?'Joined':i.revokedAt?'Revoked':new Date(i.expiresAt)<=new Date()?'Expired':'Email sent · Awaiting acceptance';
        const canRevoke=!i.accepted&&!i.revokedAt&&new Date(i.expiresAt)>new Date();
        return '<article class="history-row"><div class="history-row-top"><strong>'+escapeHtml(i.fullName||'Staff member')+'</strong><strong>'+status+'</strong></div><div class="history-row-meta">'+escapeHtml(i.role||'Shop Attendant')+' · '+escapeHtml(i.email||'')+' · '+escapeHtml(i.phone||'')+'</div><div class="history-row-meta">Invitation expires: '+escapeHtml(new Date(i.expiresAt).toLocaleString('en-KE'))+'</div>'+(canRevoke?'<button class="btn btn-light" type="button" data-revoke-invite="'+escapeHtml(i.id)+'">Revoke invitation</button>':'')+'</article>';
      }).join('');
    }catch(e){list.innerHTML='<div class="empty">'+escapeHtml(e.message||'Could not load invitations.')+'</div>';}
  }
  let staffPhotoData=null;
  $('staff-invite-photo')?.addEventListener('change',async e=>{
    const file=e.target.files?.[0],preview=$('staff-invite-photo-preview');staffPhotoData=null;
    if(!file){preview.classList.add('hidden');return;}
    try{staffPhotoData=await compressLogo(file);preview.src=staffPhotoData;preview.classList.remove('hidden');}
    catch(err){e.target.value='';preview.classList.add('hidden');$('staff-invite-message').textContent=err.message||'Could not prepare profile photo.';}
  });
  $('staff-invite-form')?.addEventListener('submit',async e=>{
    e.preventDefault();const btn=$('create-staff-invite'),message=$('staff-invite-message');
    btn.disabled=true;btn.textContent='Sending invitation…';message.textContent='Sending a secure invitation email…';
    try{
      const payload={fullName:$('staff-invite-name').value.trim(),email:$('staff-invite-email').value.trim(),phone:$('staff-invite-phone').value.trim(),role:$('staff-invite-role').value,profilePhotoData:staffPhotoData};
      const data=await request('/api/v1/staff/invitations',{method:'POST',body:JSON.stringify(payload)});
      message.textContent='Invitation email sent to '+data.invitation.email+'. The staff member can accept the link and create their own password. The link expires in 7 days.';
      $('staff-invite-form').reset();staffPhotoData=null;$('staff-invite-photo-preview').classList.add('hidden');await loadStaffInvitations();
    }catch(err){message.textContent=err.message||'Could not send the staff invitation.';}
    finally{btn.disabled=false;btn.textContent='Send email invitation';}
  });
  $('staff-invitations-list')?.addEventListener('click',async e=>{
    const btn=e.target.closest('[data-revoke-invite]');if(!btn)return;
    btn.disabled=true;
    try{await request('/api/v1/staff/invitations/'+encodeURIComponent(btn.dataset.revokeInvite),{method:'DELETE'});$('staff-invite-message').textContent='Invitation revoked.';await loadStaffInvitations();}
    catch(err){$('staff-invite-message').textContent=err.message||'Could not revoke invitation.';btn.disabled=false;}
  });
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
      const unavailable = stock <= 0;
      const stockLabel = unavailable ? 'Out of stock' : stock <= Number(p.reorderLevel) ? `Low stock · ${stock} left` : `${stock} in stock`;
      return `<button class="product-card" data-add="${p.id}" type="button" ${unavailable?'disabled aria-disabled="true"':''}><span class="product-name">${escapeHtml(p.name)}</span><span class="product-meta"><span class="price">${money(p.priceKes)}</span><span class="stock ${stockClass}">${stockLabel}</span></span>${p.sku?`<span class="stock">SKU: ${escapeHtml(p.sku)}</span>`:''}</button>`;
    }).join('');
  }
  function addToCart(id){ const p=state.products.find(x=>x.id===id); if(!p)return; const stock=Math.max(0,Number(p.stockQty)||0); const old=state.cart.get(id); if(stock<=0){showNotice('This product is out of stock.',true);return;} if((old?.qty||0)>=stock){showNotice('Available stock limit reached. Update inventory first.',true);return;} state.cart.set(id,{product:p,qty:(old?.qty||0)+1,unitPriceKes:old?.unitPriceKes??Number(p.priceKes),imei:old?.imei||''});hideNotice();renderCart(); }
  function changeQty(id,delta){const row=state.cart.get(id);if(!row)return;const next=row.qty+delta;const stock=Math.max(0,Number(row.product.stockQty)||0);if(next>stock){showNotice('Only '+stock+' units are currently in stock.',true);return;}if(next<=0)state.cart.delete(id);else row.qty=next;renderCart();}
  function totals(){const subtotal=[...state.cart.values()].reduce((s,r)=>s+Number(r.unitPriceKes??r.product.priceKes)*r.qty,0);const requested=Math.max(0,Math.floor(Number($('discount').value)||0));const discount=Math.min(subtotal,requested);if(requested>subtotal)$('discount').value=String(discount);return {subtotal,discount,total:subtotal-discount};}
  function renderCart(){
    const rows=[...state.cart.entries()]; $('cart-list').innerHTML=rows.length?rows.map(([id,r])=>`<div class="cart-row"><div><div class="cart-row-name">${escapeHtml(r.product.name)}</div><div class="cart-row-sub">Shop buying cost: ${money(r.product.costKes)} · Default selling price: ${money(r.product.priceKes)}</div><label class="cart-unit-price">Customer price per item (KSh)<input type="number" min="1" max="100000000000" step="1" inputmode="numeric" data-price="${id}" value="${Number(r.unitPriceKes??r.product.priceKes)}" required></label><div class="cart-row-sub cart-line-total">Line subtotal: ${money(Number(r.unitPriceKes??r.product.priceKes)*r.qty)}</div><label>IMEI / Serial number${r.product.requiresBuyerId?' (required)':' (if applicable)'}<input type="text" maxlength="32" data-imei="${id}" value="${escapeHtml(r.imei||'')}" placeholder="${r.product.requiresBuyerId?'Enter IMEI / serial number':'Enter if applicable'}" ${r.product.requiresBuyerId?'required':''}></label></div><div class="qty-control"><button type="button" data-qty="${id}" data-delta="-1" aria-label="Decrease">−</button><span>${r.qty}</span><button type="button" data-qty="${id}" data-delta="1" aria-label="Increase">+</button></div></div>`).join(''):'<div class="empty">Your cart is empty.</div>';
    const t=totals(); $('subtotal').textContent=money(t.subtotal);$('total').textContent=money(t.total);$('checkout-open').disabled=!rows.length||t.total<0;
  }
  function openCheckout(){const items=[...state.cart.values()];const needsBuyer=items.some(r=>r.product.requiresBuyerId);$('buyer-id-wrap').classList.remove('hidden');$('buyer-id-note').classList.toggle('hidden',!needsBuyer);$('checkout-total').textContent=money(totals().total);$('checkout-error').textContent='';$('checkout-modal').classList.remove('hidden');}
  function makeReceiptMarkup(receipt, sale, customer){
    const business=receipt.business||{};
    const lines=sale.items.map(i=>`<div class="receipt-line"><span><strong>${escapeHtml(i.name)}</strong> × ${i.qty}<br><small>Unit price: ${money(i.price)}${i.serialNo?`<br>IMEI / Serial: ${escapeHtml(i.serialNo)}`:''}</small></span><strong>${money(i.price*i.qty)}</strong></div>`).join('');
    const verifyUrl=new URL('verify.html',window.location.href).href+'?token='+encodeURIComponent(receipt.qrToken); const recoveryUrl=new URL('recover.html',window.location.href).href;
    return `<div class="receipt-center">${business.logoData?'<img class="receipt-logo" src="'+escapeHtml(business.logoData)+'" alt="Business logo">':''}<h2>${escapeHtml(business.name||'BUSINESS NAME')}</h2>
      ${business.storeName?`<div>${escapeHtml(business.storeName)}</div>`:''}
      ${business.location?`<div>${escapeHtml(business.location)}</div>`:''}
      ${business.phone?`<div>Tel: ${escapeHtml(business.phone)}</div>`:''}
      ${business.email?`<div>Email: ${escapeHtml(business.email)}</div>`:''}
      ${business.receiptHeader?`<div>${escapeHtml(business.receiptHeader)}</div>`:''}
      <div class="muted">OFFICIAL SALES RECEIPT</div></div>
      <div class="receipt-divider"></div><div>Receipt: <strong>${escapeHtml(receipt.receiptNo)}</strong></div>
      <div class="receipt-center"><strong>SCAN TO VERIFY RECEIPT</strong><div id="receipt-qr" class="receipt-qr"></div><small>Receipt verification QR code</small></div>
      <div>Date sold: ${new Date(receipt.issuedAt||Date.now()).toLocaleString('en-KE')}</div><div>Sales agent: ${escapeHtml(receipt.cashier?.name||'Staff')}</div><div>Agent phone: ${escapeHtml(receipt.cashier?.phone||'Not available')}</div><div>Payment: ${escapeHtml(sale.paymentMethod.toUpperCase())}</div>
      ${customer?`<div>Customer: ${escapeHtml(customer.fullName)}</div><div>Phone: ${escapeHtml(customer.phone)}</div>${customer.email?`<div>Email: ${escapeHtml(customer.email)}</div>`:''}`:''}
      <div class="receipt-divider"></div>${lines}<div class="receipt-divider"></div>
      <div class="receipt-line"><span>Subtotal</span><span>${money(sale.subtotal)}</span></div>
      <div class="receipt-line"><span>Discount</span><span>${money(sale.discount)}</span></div>
      <div class="receipt-line"><strong>TOTAL</strong><strong>${money(receipt.totalKes)}</strong></div>
      <div class="receipt-center" style="margin:20px auto 14px"><div class="official-paid-stamp"><div class="stamp-business">${escapeHtml(business.name||"BUSINESS NAME")}</div><div class="stamp-paid">ISSUED</div><div class="stamp-date">DATE: ${escapeHtml(new Date(receipt.issuedAt||Date.now()).toLocaleDateString('en-KE'))}</div><div class="stamp-branch">${escapeHtml(business.storeName||business.location||"OFFICIAL RECEIPT")}</div></div></div>
      <div class="receipt-divider"></div><div class="receipt-center">Thank you for shopping with us!
      ${business.receiptFooter?`<br>${escapeHtml(business.receiptFooter)}`:''}
      <br><small>Scan/check online: ${escapeHtml(verifyUrl)}</small><br><small>Lost this receipt? Recover it using your phone and OTP: ${escapeHtml(recoveryUrl)}</small></div>`;
  }
  async function completeSale(ev){
    ev.preventDefault(); const items=[...state.cart.values()]; if(!items.length)return;
    const priceInputs=[...$('cart-list').querySelectorAll('[data-price]')];
    const invalidPrice=priceInputs.some(input=>!Number.isSafeInteger(Number(input.value))||Number(input.value)<1||Number(input.value)>100000000000);
    if(invalidPrice){$('checkout-error').textContent='Enter a valid customer price for every item before issuing the receipt.';return;}
    // Read the final values directly from the visible fields at checkout so
    // the receipt payload can never fall back to an older product price.
    priceInputs.forEach(input=>{const row=state.cart.get(input.dataset.price);if(row)row.unitPriceKes=Number(input.value);});
    const t=totals(); const needsBuyer=items.some(r=>r.product.requiresBuyerId);
    if(items.some(r=>r.product.requiresBuyerId&&!String(r.imei||'').trim())){$('checkout-error').textContent='Enter the IMEI / serial number for each item that requires buyer identification.';return;}
    const customer={fullName:$('buyer-name').value.trim(),phone:$('buyer-phone').value.trim(),email:$('buyer-email').value.trim(),nationalId:$('buyer-id').value.trim()};
    if(!customer.fullName||!customer.phone||!customer.email||!customer.nationalId){ $('checkout-error').textContent='Enter the customer full name, phone number, email and National ID before issuing the receipt.';return; }
    if(needsBuyer&&(!customer.fullName||!customer.phone||!customer.nationalId)){ $('checkout-error').textContent='Enter the buyer full name, phone number and National ID for this item.';return; }
    const saleId=uuid();const payload={clientUuid:saleId,receiptNo:`SW-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${saleId.replace(/-/g,'').slice(0,10).toUpperCase()}`,paymentMethod:$('payment-method').value,discountKes:t.discount,items:items.map(r=>({productId:r.product.id,qty:r.qty,unitPriceKes:Number(r.unitPriceKes??r.product.priceKes),...(r.imei&&r.imei.trim()?{serialNo:r.imei.trim()}: {})}))};
    payload.customer=customer;
    const btn=$('complete-sale');btn.disabled=true;btn.textContent='Issuing receipt…';$('checkout-error').textContent='';
    try{
      const receipt=await request('/api/v1/receipts',{method:'POST',body:JSON.stringify(payload)});
      state.lastReceipt=receipt; const sale={items:items.map(r=>({name:r.product.name,qty:r.qty,price:Number(r.unitPriceKes??r.product.priceKes),serialNo:r.imei&&r.imei.trim()?r.imei.trim():null})),subtotal:Number(receipt.subtotalKes??t.subtotal),discount:Number(receipt.discountKes??t.discount),paymentMethod:payload.paymentMethod};
      $('receipt-paper').innerHTML=makeReceiptMarkup(receipt,sale,payload.customer);if(window.QRCode&&receipt.qrToken){try{const verifyUrl=new URL('verify.html',window.location.href).href+'?token='+encodeURIComponent(receipt.qrToken);new QRCode($('receipt-qr'),{text:verifyUrl,width:116,height:116,correctLevel:QRCode.CorrectLevel.M});}catch{}}$('checkout-modal').classList.add('hidden');$('receipt-modal').classList.remove('hidden');state.cart.clear();$('discount').value='0';$('checkout-form').reset();renderCart();const emailStatus=$('receipt-email-status');if(emailStatus){emailStatus.textContent='Email: '+(receipt.emailDelivery?.message||(payload.customer?.email?'Delivery status unavailable.':'No customer email was provided.'))+' WhatsApp: '+(receipt.whatsappDelivery?.message||(payload.customer?.phone?'Delivery status unavailable.':'No customer phone was provided.'));emailStatus.classList.toggle('error',!!((payload.customer?.email&&!receipt.emailDelivery?.sent)||(payload.customer?.phone&&!receipt.whatsappDelivery?.sent)));}window.dispatchEvent(new CustomEvent('swass:sale-issued',{detail:{receiptNo:receipt.receiptNo,totalKes:receipt.totalKes}}));await loadProducts();hideNotice();
    }catch(e){$('checkout-error').textContent=e.message;}
    finally{btn.disabled=false;btn.textContent='Issue receipt';}
  }
  // Tuma subscription and wallet payments
  const tumaForm = $('owner-mpesa-form');
  const tumaPurpose = $('owner-mpesa-purpose');
  const syncTumaFields = () => {
    const isSubscription = tumaPurpose?.value === 'subscription';
    $('owner-topup-amount-wrap')?.classList.toggle('hidden', isSubscription);
    $('owner-plan-wrap')?.classList.toggle('hidden', !isSubscription);
  };
  if (tumaPurpose) {
    tumaPurpose.addEventListener('change', syncTumaFields);
    syncTumaFields();
  }
  if (tumaForm) tumaForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = $('owner-mpesa-message');
    const button = tumaForm.querySelector('button[type="submit"]');
    const purpose = tumaPurpose?.value || 'wallet_topup';
    const payload = { purpose, phone: $('owner-mpesa-phone').value.trim() };
    if (purpose === 'subscription') payload.plan = $('owner-subscription-plan').value;
    else payload.amountKes = Number($('owner-topup-amount').value);
    button.disabled = true;
    message.textContent = 'Connecting securely to Tuma Payments…';
    try {
      const started = await request('/api/v1/mpesa/stk-push', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      message.textContent = started.message || 'STK prompt requested. Check your phone and enter your M-Pesa PIN.';
      if (!started.paymentId) throw new Error('Tuma did not return a payment reference. Contact support before trying again.');
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        const current = await request('/api/v1/mpesa/payments/' + encodeURIComponent(started.paymentId));
        if (current.status === 'success') {
          message.textContent = 'Payment confirmed successfully' + (current.receiptNumber ? ' · M-Pesa receipt: ' + current.receiptNumber : '') + '. Your SWASS subscription or wallet has been updated.';
          showNotice('Tuma payment confirmed successfully.');
          return;
        }
        if (current.status === 'failed') {
          message.textContent = 'Tuma reports that this payment was not completed. You can try again.';
          return;
        }
        message.textContent = 'Waiting for M-Pesa confirmation… Please complete the prompt on your phone.';
      }
      message.textContent = 'Payment is still pending. Do not pay again yet; refresh the payment page or contact support to check its status.';
    } catch (error) {
      message.textContent = error.message || 'Could not start or verify the Tuma payment. Please try again later.';
    } finally {
      button.disabled = false;
    }
  });
  $('customer-lookup-form').addEventListener('submit',lookupCustomer);
  $('customer-lookup-result').addEventListener('click',e=>{
    if(e.target.id==='add-customer-package'){
      $('products-panel')?.scrollIntoView({behavior:'smooth',block:'start'});
      $('product-search').focus();
      showNotice('Select the registered goods the customer is buying. They will be added to a new receipt.');
    }
    if(e.target.id==='register-lookup-customer'){
      $('buyer-name').value='';$('buyer-phone').value=$('lookup-phone').value.trim();$('buyer-email').value='';$('buyer-id').value=$('lookup-national-id').value.trim();
      showNotice('New customer details will be saved when you issue their first receipt. Select the goods below, then enter the customer name at checkout.');
      $('products-panel').scrollIntoView({behavior:'smooth',block:'start'});
      $('product-search').focus();
    }
  });
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
  function updateSignupAccountType(){
    $('reg-account-type').value='owner';
    $('owner-signup-fields').classList.remove('hidden');
    $('reg-business').required=true;
    $('reg-store').required=true;
    $('reg-password').required=true;
    $('reg-password-field').classList.remove('hidden');
    $('register-submit').textContent='Create business · Send verification code';
  }
  updateSignupAccountType();
  let signupResendTimer = null;
  let signupResendSeconds = 0;
  function signupPayload(){
    return {
      accountType:'owner',
      businessName:$('reg-business').value.trim(),
      storeName:$('reg-store').value.trim(),
      storeLocation:$('reg-location').value.trim(),
      fullName:$('reg-name').value.trim(),
      phone:$('reg-phone').value.trim(),
      email:$('reg-email').value.trim(),
      password:$('reg-password').value
    };
  }
  function startSignupResendCountdown(){
    if(signupResendTimer)clearInterval(signupResendTimer);
    signupResendSeconds=30;
    $('resend-signup-otp').disabled=true;
    $('resend-signup-otp').textContent='Resend code in 30 seconds';
    signupResendTimer=setInterval(()=>{
      signupResendSeconds--;
      if(signupResendSeconds<=0){
        clearInterval(signupResendTimer);signupResendTimer=null;
        $('resend-signup-otp').disabled=false;
        $('resend-signup-otp').textContent='Resend verification code';
      }else{
        $('resend-signup-otp').textContent='Resend code in '+signupResendSeconds+' seconds';
      }
    },1000);
  }
  async function requestSignupOtp(){
    $('register-error').textContent='';$('signup-otp-message').textContent='';
    const btn=$('register-submit');btn.disabled=true;btn.textContent='Sending code…';
    try{
      $('register-error').textContent='Connecting to SWASS server…';
      await warmApi();
      $('register-error').textContent='';
      const data=await request('/api/v1/auth/register',{method:'POST',body:JSON.stringify(signupPayload())});
      $('register-fields').classList.add('hidden');
      $('register-submit').classList.add('hidden');
      $('signup-otp-panel').classList.remove('hidden');
      $('signup-otp-code').focus();
      $('signup-otp-message').textContent=data.developmentCode
        ? 'Development test code: '+data.developmentCode+' (production codes are sent only by SMS).'
        : 'Verification code sent. It expires in 5 minutes.';
      startSignupResendCountdown();
    }catch(err){
      $('register-error').textContent=err.message||'Could not send the verification code. Please try again.';
    }finally{btn.disabled=false;btn.textContent='Send verification code';}
  }
  $('register-form').addEventListener('submit',async e=>{
    e.preventDefault();
    if(!$('signup-otp-panel').classList.contains('hidden'))return;
    await requestSignupOtp();
  });
  $('resend-signup-otp').addEventListener('click',async()=>{
    if(signupResendSeconds>0)return;
    await requestSignupOtp();
  });
  $('verify-signup-otp').addEventListener('click',async()=>{
    const btn=$('verify-signup-otp');
    const code=$('signup-otp-code').value.trim();
    $('signup-otp-message').textContent='';
    if(!/^\d{6}$/.test(code)){
      $('signup-otp-message').textContent='Enter the complete 6-digit code sent to your phone.';
      return;
    }
    btn.disabled=true;btn.textContent='Verifying phone…';
    try{
      const data=await request('/api/v1/auth/register/verify-otp',{
        method:'POST',
        body:JSON.stringify({phone:$('reg-phone').value.trim(),code})
      });
      state.token=data.accessToken;
      state.userName=$('reg-name').value.trim();
      const parts=state.token.split('.')[1];
      const claims=JSON.parse(atob(parts.replace(/-/g,'+').replace(/_/g,'/')));
      state.role=claims.role;
      if(signupResendTimer)clearInterval(signupResendTimer);
      const registeredPhone=$('reg-phone').value.trim();
      $('register-form').reset();
      updateSignupAccountType();
      $('register-fields').classList.remove('hidden');
      $('signup-otp-panel').classList.add('hidden');
      $('register-submit').classList.remove('hidden');
      showPOS();
      publishWorkspaceSession();
      showWorkspaceScreen('accounting');
      showNotice('Your business account is ready. Subscribe for KSh 100 per month (or KSh 900 per year), then top up your receipt wallet.');
    }catch(err){
      $('signup-otp-message').textContent=err.message||'Verification failed. Check the code and try again.';
    }finally{btn.disabled=false;btn.textContent='Verify phone and create account';}
  });
  $('login-form').addEventListener('submit',async e=>{
    e.preventDefault();
    const button=$('login-form').querySelector('button[type="submit"]');
    $('login-error').textContent='';
    if(button){button.disabled=true;button.textContent='Signing in…';}
    let signedIn=false;
    try{
      const data=await request('/api/v1/auth/login',{
        method:'POST',
        body:JSON.stringify({phone:$('login-phone').value.trim(),password:$('login-password').value})
      });
      if(!data.accessToken)throw new Error('The server did not return a sign-in token. Please try again.');
      const parts=data.accessToken.split('.')[1];
      const claims=JSON.parse(atob(parts.replace(/-/g,'+').replace(/_/g,'/')));
      state.token=data.accessToken;
      state.role=claims.role;
      state.userName=data.user?.fullName||data.user?.name||data.user?.displayName||claims.fullName||claims.name||claims.displayName||claims.firstName||'';state.staffTitle=data.user?.staffTitle||'';state.userPhotoData=data.user?.profilePhotoData||'';
      if(data.mustChangePassword || claims.mustChangePassword){
        $('login-form').classList.add('hidden');
        $('show-password-reset').parentElement.classList.add('hidden');
        $('first-password-form').classList.remove('hidden');
        $('first-password-message').textContent='This is your temporary shop access code. Create your own password to continue.';
        return;
      }
      signedIn=true;
      showPOS();
      publishWorkspaceSession();
      hideNotice();
      $('login-error').textContent='';
    }catch(err){
      state.token=null;
      state.role=null;
      state.userName='';state.staffTitle='';state.userPhotoData='';
      $('login-error').textContent=err.message||'Sign-in failed. Check your phone number and password.';
    }finally{
      if(button){button.disabled=false;button.textContent='Sign in';}
    }
    if(!signedIn)return;
    let subscriptionRequired = false;
    if(['owner','manager'].includes(state.role)){
      try{await loadBusinessProfile();}
      catch(err){
        if(err.status === 402) subscriptionRequired = true;
        else showNotice('You are signed in, but the business profile could not be loaded. '+(err.message||''),true);
      }
    }
    if(!subscriptionRequired){
      try { await loadProducts(); }
      catch (loadError) {
        if(loadError.status === 402) subscriptionRequired = true;
        else showNotice('You are signed in, but the product list could not load. Refresh the page to try again.', true);
      }
    }
    if(subscriptionRequired){
      showWorkspaceScreen('accounting');
      showNotice('SWASS is locked until you subscribe. Pay KSh 100 for one month or KSh 900 for one year, then add receipt credits at KSh 2 each.');
    } else if(state.role==='cashier') {
      showWorkspaceScreen('receipts');
    } else {
      showWorkspaceScreen('dashboard');
    }
  });
  $('first-password-form').addEventListener('submit',async e=>{
    e.preventDefault();
    const password=$('first-new-password').value;
    const confirm=$('first-confirm-password').value;
    const message=$('first-password-message');
    if(password.length<10){message.textContent='Use at least 10 characters.';return;}
    if(password!==confirm){message.textContent='The passwords do not match.';return;}
    const btn=$('save-first-password');btn.disabled=true;btn.textContent='Saving…';
    try{
      const result=await request('/api/v1/auth/change-password',{method:'POST',body:JSON.stringify({newPassword:password})});
      clearSession();
      $('first-password-form').classList.add('hidden');
      $('show-password-reset').parentElement.classList.remove('hidden');
      $('login-form').classList.remove('hidden');
      $('login-password').value='';
      $('first-new-password').value='';$('first-confirm-password').value='';
      message.textContent=result.message||'Password saved. Sign in with your new password.';
      $('login-error').textContent='Your password is ready. Sign in using your new password.';
    }catch(err){message.textContent=err.message||'Could not save your password.';}
    finally{btn.disabled=false;btn.textContent='Save my password';}
  });
  $('show-password-reset').addEventListener('click',()=>{
    $('login-form').classList.add('hidden');
    $('password-reset-form').classList.remove('hidden');
    $('password-reset-message').textContent='';
    $('password-reset-confirm-fields').classList.add('hidden');
  });
  $('cancel-password-reset').addEventListener('click',()=>{
    $('password-reset-form').classList.add('hidden');
    $('login-form').classList.remove('hidden');
  });
  $('password-reset-form').addEventListener('submit',async e=>{
    e.preventDefault();
    const btn=$('request-password-reset');
    btn.disabled=true;btn.textContent='Sending code…';
    $('password-reset-message').textContent='Requesting a secure reset code…';
    try{
      const result=await request('/api/v1/auth/password-reset/request',{method:'POST',body:JSON.stringify({phone:$('reset-phone').value.trim()})});
      $('password-reset-confirm-fields').classList.remove('hidden');
      $('password-reset-message').textContent=result.message||'If an account matches that phone number, a password reset code has been sent.';
    }catch(err){$('password-reset-message').textContent=err.message||'Could not request a reset code.';}
    finally{btn.disabled=false;btn.textContent='Send reset code';}
  });
  $('confirm-password-reset').addEventListener('click',async()=>{
    const btn=$('confirm-password-reset');
    const code=$('reset-code').value.trim(),newPassword=$('reset-new-password').value;
    if(!/^\d{6}$/.test(code)){$('password-reset-message').textContent='Enter the six-digit code sent by SMS.';return;}
    if(newPassword.length<10||newPassword.length>128){$('password-reset-message').textContent='Your new password must be at least 10 characters.';return;}
    btn.disabled=true;btn.textContent='Updating password…';
    $('password-reset-message').textContent='';
    try{
      const result=await request('/api/v1/auth/password-reset/confirm',{method:'POST',body:JSON.stringify({
        phone:$('reset-phone').value.trim(),code:$('reset-code').value.trim(),newPassword:$('reset-new-password').value
      })});
      $('password-reset-message').textContent=result.message||'Password updated. You can now sign in.';
      $('password-reset-form').classList.add('hidden');
      $('login-form').classList.remove('hidden');
      $('login-phone').value=$('reset-phone').value.trim();
      $('login-password').value='';
    }catch(err){$('password-reset-message').textContent=err.message||'Password could not be reset.';}
    finally{btn.disabled=false;btn.textContent='Reset password';}
  });
  $('workspace-nav').addEventListener('click',e=>{const b=e.target.closest('[data-workspace]');if(b)showWorkspaceScreen(b.dataset.workspace);});
  $('back-to-receipts').addEventListener('click',()=>{
    $('pos-view').classList.add('hidden');
    $('pos-view').classList.remove('workspace-issue-mode');
    $('receipts-home').classList.remove('hidden');
  });
  $('open-issue-receipt').addEventListener('click',()=>{
    $('receipts-home').classList.add('hidden');
    $('pos-view').classList.remove('hidden');
    $('pos-view').classList.add('workspace-issue-mode');
    document.querySelector('.pos-grid')?.classList.remove('hidden');
    $('history-panel').classList.remove('hidden');
    $('history-content').classList.add('hidden');
    $('history-toggle').textContent='Open history';
    document.querySelector('.page-heading')?.scrollIntoView({block:'start'});
  });
  $('open-recover-receipt').addEventListener('click',()=>{window.location.href='recover.html';});
  document.querySelector('.dashboard-sidebar')?.addEventListener('click',e=>{const link=e.target.closest('.sidebar-link');if(!link)return;const screen=link.dataset.screen||(link.getAttribute('href')==='#owner-customers-section'?'customers':link.getAttribute('href')==='#owner-reports-section'?'reports':link.getAttribute('href')==='#owner-payments-section'?'payments':'overview');e.preventDefault();showWorkspaceScreen(screen);});
  $('history-toggle').addEventListener('click',async()=>{const box=$('history-content');const opening=box.classList.contains('hidden');box.classList.toggle('hidden');$('history-toggle').textContent=opening?'Close history':'Open history';if(opening)await loadReceiptHistory();});
  $('history-search-btn').addEventListener('click',loadReceiptHistory);
  $('history-search').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();loadReceiptHistory();}});
  $('dashboard-edit-profile').addEventListener('click',()=>{$('profile-panel').classList.remove('hidden');$('profile-panel').scrollIntoView({behavior:'smooth',block:'start'});});
  $('profile-close').addEventListener('click',()=>{$('profile-panel').classList.add('hidden');$('dashboard-business-card').scrollIntoView({behavior:'smooth',block:'start'});});
  $('business-logo').addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;const img=$('logo-preview');img.classList.remove('hidden');img.alt='Preparing selected business logo…';$('profile-error').textContent='Preparing logo…';try{state.profileLogoData=await compressLogo(file);img.src=state.profileLogoData;img.alt='Selected business logo preview';$('profile-error').textContent='Logo preview ready. Tap Save business profile to keep it.';}catch(err){state.profileLogoData=undefined;e.target.value='';img.removeAttribute('src');img.classList.add('hidden');$('profile-error').textContent=err.message;}});
  $('profile-form').addEventListener('submit',async e=>{e.preventDefault();const btn=$('profile-form').querySelector('button[type="submit"]');btn.disabled=true;btn.textContent='Saving…';$('profile-error').textContent='';const payload={businessName:$('profile-business-name').value.trim(),businessPhone:$('profile-business-phone').value.trim(),businessEmail:$('profile-business-email').value.trim()||null,storeName:$('profile-store-name').value.trim(),storeLocation:$('profile-store-location').value.trim()||null,receiptHeader:$('profile-receipt-header').value.trim()||null,receiptFooter:$('profile-receipt-footer').value.trim()||null};if(state.profileLogoData!==undefined)payload.logoData=state.profileLogoData;try{await request('/api/v1/business/profile',{method:'PATCH',body:JSON.stringify(payload)});state.businessProfile={...state.businessProfile,...payload};renderDashboardBusinessProfile();$('profile-panel').classList.add('hidden');showNotice('Business profile saved. Your logo and details will appear on new receipts.');}catch(err){$('profile-error').textContent=err.message||'Could not save business profile.';}finally{btn.disabled=false;btn.textContent='Save business profile';}});
  $('logout-btn').addEventListener('click',()=>{clearSession();window.dispatchEvent(new Event('swass:logout'));state.cart.clear();renderCart();$('profile-panel').classList.add('hidden');showLogin();});
  $('product-list').addEventListener('click',e=>{const b=e.target.closest('[data-add]');if(b)addToCart(b.dataset.add);});
  $('cart-list').addEventListener('click',e=>{const b=e.target.closest('[data-qty]');if(b)changeQty(b.dataset.qty,Number(b.dataset.delta));});
  $('cart-list').addEventListener('input',e=>{const price=e.target.closest('[data-price]');if(price){const row=state.cart.get(price.dataset.price);const value=Number(price.value);if(!row||!Number.isSafeInteger(value)||value<1||value>100000000000){$('checkout-open').disabled=true;return;}if(row&&Number.isSafeInteger(value)&&value>=1&&value<=100000000000){row.unitPriceKes=value;const line=price.closest('.cart-row')?.querySelector('.cart-line-total');if(line)line.textContent='Line subtotal: '+money(value*row.qty);const t=totals();$('subtotal').textContent=money(t.subtotal);$('total').textContent=money(t.total);$('checkout-open').disabled=!state.cart.size||t.total<0||[...$('cart-list').querySelectorAll('[data-price]')].some(input=>!Number.isSafeInteger(Number(input.value))||Number(input.value)<1||Number(input.value)>100000000000);}return;}const field=e.target.closest('[data-imei]');if(field){const row=state.cart.get(field.dataset.imei);if(row)row.imei=field.value;}});
  let productSearchTimer;
  $('product-search').addEventListener('input',()=>{clearTimeout(productSearchTimer);productSearchTimer=setTimeout(loadProducts,300);});
  $('low-stock').addEventListener('change',()=>loadProducts());$('refresh-btn').addEventListener('click',loadProducts);
  $('discount').addEventListener('input',renderCart);$('clear-cart').addEventListener('click',()=>{state.cart.clear();$('discount').value='0';renderCart();});
  $('checkout-open').addEventListener('click',openCheckout);$('checkout-close').addEventListener('click',()=>$('checkout-modal').classList.add('hidden'));$('checkout-form').addEventListener('submit',completeSale);
  $('receipt-close').addEventListener('click',()=>$('receipt-modal').classList.add('hidden'));$('new-sale').addEventListener('click',()=>$('receipt-modal').classList.add('hidden'));$('print-receipt').addEventListener('click',()=>window.print());
  const shareBtn=$('share-receipt'); if(shareBtn) shareBtn.addEventListener('click', async()=>{ if(!state.lastReceipt)return; const verifyUrl=new URL('verify.html',window.location.href).href+'?token='+encodeURIComponent(state.lastReceipt.qrToken); const text=`SWASS receipt ${state.lastReceipt.receiptNo} · KSh ${Number(state.lastReceipt.totalKes).toLocaleString('en-KE')} · Verify: ${verifyUrl}`; try { if(navigator.share) await navigator.share({title:'SWASS receipt',text}); else if(navigator.clipboard) { await navigator.clipboard.writeText(text); alert('Receipt summary copied.'); } } catch {} });
  // Installable Android experience: this adds the app without replacing the website.
  let deferredInstallPrompt = null;
  const installAppButton = $('install-app-btn');
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    if (installAppButton) installAppButton.classList.remove('hidden');
  });
  if (installAppButton) installAppButton.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installAppButton.classList.add('hidden');
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    if (installAppButton) installAppButton.classList.add('hidden');
  });
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(error => console.warn('[SWASS] App installation support unavailable:', error?.message || 'registration failed')));
  }
  // Keep the signed-in session across refreshes; expire it after 3 idle hours.
  ['pointerdown','keydown','touchstart','click','scroll'].forEach(type=>window.addEventListener(type,touchSession,{passive:true}));
  window.addEventListener('focus',checkSessionExpiry);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')checkSessionExpiry();});
  window.setInterval(checkSessionExpiry,30000);
  // API URL is configurable without rebuilding: set window.SWASS_API_URL before app.js.
  if(!API){ showNotice('API address is not configured yet. Set SWASS_API_URL in frontend/config.js to your running API URL.',true); }
  renderCart();void restoreSession();
})();
