(() => {
  'use strict';
  const $ = id => document.getElementById(id.startsWith('owner-') ? id : `owner-${id}`);
  const API = (window.SWASS_API_URL || '').replace(/\/$/, '');
  const state = { token: null, role: null, dashboardRequest: null, lastDashboardData: null };
  const DASHBOARD_CACHE_KEY='swass-dashboard-cache-v1';
  const DASHBOARD_REFRESH_MS=60000;
  const money = n => `KSh ${Number(n || 0).toLocaleString('en-KE')}`;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function request(path, options={}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(()=>controller.abort(),90000);
    try{
      const res = await fetch(`${API}${path}`, { ...options, signal:options.signal||controller.signal, headers:{'Content-Type':'application/json', ...(state.token?{Authorization:`Bearer ${state.token}`}:{})} });
      const data = await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
      return data;
    }catch(error){
      if(error.name==='AbortError') throw new Error('The dashboard request timed out after 90 seconds. Check your connection and tap Refresh to try again.');
      throw error;
    }finally{window.clearTimeout(timeout);}
  }
  function showLogin(){ $('login-view').classList.remove('hidden'); $('dashboard-view').classList.add('hidden'); $('logout-btn').classList.add('hidden'); }
  function showDashboard(){ $('login-view').classList.add('hidden'); $('dashboard-view').classList.remove('hidden'); $('logout-btn').classList.remove('hidden'); $('user-label').textContent=state.role; }
  function notice(msg,error=false){$('notice').textContent=msg;$('notice').classList.remove('hidden');$('notice').style.background=error?'#fff0ef':'#eef8f0';$('notice').style.color=error?'#a12b22':'#21643a';}
  function localDate(d){const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');return `${y}-${m}-${day}`;}
  function initializePeriod(){const now=new Date();$('date-from').value=localDate(new Date(now.getFullYear(),now.getMonth(),1));$('date-to').value=localDate(now);}
  function periodQuery(){const p=new URLSearchParams();if($('date-from').value)p.set('from',$('date-from').value);if($('date-to').value)p.set('to',$('date-to').value);return p.toString()? `?${p}`:'';}
  function previousPeriodQuery(){
    const from=$('date-from').value,to=$('date-to').value;
    if(!from||!to)return '';
    const start=new Date(`${from}T00:00:00Z`),end=new Date(`${to}T00:00:00Z`);
    if(Number.isNaN(start.getTime())||Number.isNaN(end.getTime())||end<start)return '';
    const days=Math.round((end-start)/86400000)+1;
    const previousEnd=new Date(start.getTime()-86400000);
    const previousStart=new Date(previousEnd.getTime()-(days-1)*86400000);
    const fmt=d=>d.toISOString().slice(0,10);
    return `?from=${fmt(previousStart)}&to=${fmt(previousEnd)}`;
  }
  function comparisonLabel(current,previous){
    if(previous===0)return current===0?'No change':'New activity';
    const change=((current-previous)/previous)*100;
    return `${change>0?'+':''}${change.toFixed(1)}%`;
  }
  async function loadDashboard(){
    if(state.dashboardRequest)return state.dashboardRequest;
    state.dashboardRequest=(async()=>{
    $('compare-sales').textContent='Loading…';
    $('compare-transactions').textContent='Loading…';
    $('mtd-sales').textContent='Loading…';
    $('product-pie').innerHTML='<span>Loading…</span>';
    $('product-legend').innerHTML='<p class="muted">Loading product sales…</p>';
    const currentRequest=request(`/api/v1/dashboard/summary${periodQuery()}`);
    const comparisonRequest=request(`/api/v1/dashboard/comparison${periodQuery()}`);
    // Expenses are secondary; never make the sales dashboard wait for them.
    void loadExpenses().catch(()=>{$('expense-list').innerHTML='<p class="muted">Expenses could not be loaded.</p>';});
    try {
      const [data,comparisonResult]=await Promise.all([
        currentRequest,
        comparisonRequest.then(value=>({value})).catch(error=>({error}))
      ]);
      state.lastDashboardData=data;
      try{sessionStorage.setItem(DASHBOARD_CACHE_KEY,JSON.stringify({savedAt:Date.now(),data}));}catch{}
      const s=data.sales,i=data.inventory,e=data.expenses;
      $('owner-today-sales').textContent=money(s.salesKes);$('owner-net-profit').textContent=money(s.estimatedNetOperatingKes);$('owner-low-stock').textContent=Number(i.lowStockCount||0).toLocaleString('en-KE');$('m-sales').textContent=money(s.salesKes);$('m-transactions').textContent=`${s.transactions} transactions`;
      $('m-profit').textContent=money(s.grossProfitKes);$('m-expenses').textContent=money(s.expensesKes);$('m-expense-count').textContent=`${e.count} entries`;$('m-net').textContent=money(s.estimatedNetOperatingKes);
      $('m-products').textContent=i.productCount;$('m-products-top').textContent=Number(i.productCount||0).toLocaleString('en-KE');$('m-locations').textContent='0';$('m-month-transactions').textContent=Number(s.transactions||0).toLocaleString('en-KE');$('channel-pos').textContent=money(s.salesKes);$('channel-api').textContent=money(0);$('channel-invoices').textContent=money(0);$('channel-offline').textContent=money(0);$('m-low').textContent=`${i.lowStockCount} need restocking`;$('m-stock-cost').textContent=money(i.stockCostKes);$('m-stock-retail').textContent=`Retail value: ${money(i.stockRetailKes)}`;$('m-discounts').textContent=money(s.discountsKes);
      $('m-wallet').textContent=money(data.subscription?.balanceKes||0);$('m-subscription').textContent=data.subscription?`${data.subscription.plan} plan · ${data.subscription.status}`:'No subscription details';
      const mtd=data.monthToDate||{};
      $('mtd-sales').textContent=money(mtd.salesKes);
      $('mtd-transactions').textContent=`${Number(mtd.transactions||0).toLocaleString('en-KE')} transactions · ${mtd.from||'this month'} to date`;
      if(comparisonResult.error){
        $('compare-sales').textContent='Unavailable';$('compare-transactions').textContent='Unavailable';
        $('compare-sales-detail').textContent='Comparison is temporarily unavailable; the main sales figures are loaded';
        $('compare-transactions-detail').textContent='Comparison is temporarily unavailable; the main sales figures are loaded';
      }else{
        const previous=comparisonResult.value.previous||{};
        const priorSales=Number(previous.salesKes||0),priorTransactions=Number(previous.transactions||0);
        $('compare-sales').textContent=comparisonLabel(Number(s.salesKes||0),priorSales);
        $('compare-sales-detail').textContent=`${money(s.salesKes)} now · ${money(priorSales)} previous`;
        $('compare-transactions').textContent=comparisonLabel(Number(s.transactions||0),priorTransactions);
        $('compare-transactions-detail').textContent=`${Number(s.transactions||0)} now · ${priorTransactions} previous`;
      }
      renderDaily(data.daily||[]);
      renderProductMix(data.productSales||[]);
      renderCashiers(data.cashiers||[]);
      $('notice').classList.add('hidden');
    } catch(err){
      notice(err.message,true);
      $('compare-sales').textContent='Unavailable';
      $('compare-transactions').textContent='Unavailable';
      $('mtd-sales').textContent='Unavailable';
      $('product-pie').innerHTML='<span>Sales data unavailable</span>';
      $('product-legend').innerHTML='<p class="muted">Product sales could not be loaded.</p>';
      $('daily-chart').innerHTML='<p class="muted">Daily sales could not be loaded. Tap Refresh to retry.</p>';
      $('cashier-rows').innerHTML='<tr><td colspan="3">Cashier figures are unavailable.</td></tr>';
      $('m-sales').textContent='Unavailable';$('m-transactions').textContent='Sales summary unavailable';
      $('m-profit').textContent='Unavailable';$('m-expenses').textContent='Unavailable';$('m-net').textContent='Unavailable';
    }
    })();
    try{return await state.dashboardRequest;}finally{state.dashboardRequest=null;}
  }
  function renderProductMix(rows){
    const colors=['#2676b8','#16a36a','#e6a23c','#8b65c8','#e16b75','#36a6a6','#65758b','#c27b42','#789b42','#b05c9d','#4b83a8','#9a8c73'];
    const valid=rows.filter(row=>Number(row.salesKes)>0);
    const total=valid.reduce((sum,row)=>sum+Number(row.salesKes),0);
    if(!valid.length||!total){
      $('product-pie').innerHTML='<span>No product sales<br>for these dates</span>';
      $('product-legend').innerHTML='<p class="muted">Issued receipts with item details will appear here.</p>';
      return;
    }
    let cursor=0;
    const slices=valid.map((row,index)=>{
      const start=cursor;
      cursor+=Number(row.salesKes)/total*100;
      return `${colors[index%colors.length]} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
    });
    $('product-pie').style.background=`conic-gradient(${slices.join(',')})`;
    $('product-pie').innerHTML=`<span>${money(total)}<small>Total product sales</small></span>`;
    $('product-legend').innerHTML=valid.map((row,index)=>{
      const share=Number(row.salesKes)/total*100;
      return `<div class="product-legend-row"><i style="background:${colors[index%colors.length]}"></i><span><strong>${esc(row.name)}</strong><small>${Number(row.unitsSold||0)} units · ${share.toFixed(1)}%</small></span><b>${money(row.salesKes)}</b></div>`;
    }).join('');
  }
  function renderDaily(rows){const max=Math.max(1,...rows.map(r=>Number(r.salesKes)));$('daily-chart').innerHTML=rows.length?rows.map(r=>{const h=Math.max(3,Number(r.salesKes)/max*125);return `<div class="day-bar" title="${esc(r.day)} · ${money(r.salesKes)}"><small>${money(r.salesKes)}</small><i style="height:${h}px"></i><b>${new Date(`${r.day}T00:00:00`).toLocaleDateString('en-KE',{day:'numeric',month:'short'})}</b></div>`;}).join(''):'<p class="muted">No sales data for this period.</p>';}
  function renderCashiers(rows){$('cashier-rows').innerHTML=rows.length?rows.map(r=>`<tr><td>${esc(r.name)}</td><td>${r.transactions}</td><td>${money(r.salesKes)}</td></tr>`).join(''):'<tr><td colspan="3">No cashier sales for this period.</td></tr>';}
  async function loadCustomers(){
    const q=$('crm-search').value.trim();const p=new URLSearchParams();if(q)p.set('q',q);p.set('limit','100');
    $('crm-message').textContent='Loading customers…';
    try{const data=await request('/api/v1/customers?'+p.toString());const rows=data.customers||[];
      $('crm-rows').innerHTML=rows.length?rows.map(c=>`<tr><td><strong>${esc(c.fullName)}</strong></td><td>${esc(c.phone)}<br><small>${esc(c.email||'No email')}</small></td><td>${Number(c.purchaseCount)}</td><td>${money(c.lifetimeSpendKes)}</td><td>${Number(c.loyaltyPoints)}</td><td>${c.lastPurchaseAt?new Date(c.lastPurchaseAt).toLocaleDateString('en-KE'):'No purchases yet'}</td></tr>`).join(''):'<tr><td colspan="6">No customers found. Customer records are created when you issue receipts with customer details.</td></tr>';
      $('crm-message').textContent=`${rows.length} customer record(s) shown.`;
    }catch(e){$('crm-rows').innerHTML='<tr><td colspan="6">Could not load customers.</td></tr>';$('crm-message').textContent=e.message;}
  }
  async function loadExpenses(){const data=await request('/api/v1/dashboard/expenses?limit=8');$('expense-list').innerHTML=data.expenses?.length?data.expenses.map(x=>`<div class="expense-row"><div><strong>${esc(x.category)}</strong><small>${new Date(x.spentAt).toLocaleDateString('en-KE')}${x.note?` · ${esc(x.note)}`:''}</small></div><b>${money(x.amountKes)}</b></div>`).join(''):'<p class="muted">No expenses recorded.</p>';}

  function activateOwnerWorkspace(session){
    state.token=session?.token||null;state.role=session?.role||null;
    if(!state.token||!['owner','manager'].includes(state.role))return;
    $('owner-dashboard-view').classList.remove('hidden');
    $('owner-dashboard-view').classList.remove('workspace-accounting','workspace-console');
    $('owner-dashboard-view').classList.add('workspace-dashboard');
    document.getElementById('pos-view').classList.remove('hidden');
    document.querySelector('.pos-grid')?.classList.add('hidden');
    ['history-panel','owner-customers-section','profile-panel'].forEach(id=>document.getElementById(id)?.classList.add('hidden'));
    document.querySelector('.customer-lookup-panel')?.classList.add('hidden');
    document.getElementById('workspace-nav').classList.remove('hidden');
    document.querySelectorAll('#workspace-nav button').forEach(b=>b.classList.toggle('active',b.dataset.workspace==='dashboard'));
    initializePeriod();loadDashboard();loadCustomers();
  }
  window.addEventListener('swass:login',ev=>activateOwnerWorkspace(ev.detail||{}));
  // app.js restores a saved session before dashboard.js is loaded on refresh.
  // That early login event would otherwise be missed, leaving the dashboard uninitialized.
  function restoreDashboardSession(){
    try{
      const saved=JSON.parse(localStorage.getItem('swass-auth-session-v1')||'null');
      if(!saved?.token||!Number.isFinite(saved.lastActivity)||Date.now()-saved.lastActivity>3*60*60*1000)return;
      const payload=saved.token.split('.')[1];
      const claims=JSON.parse(atob(payload.replace(/-/g,'+').replace(/_/g,'/')));
      if(!claims.exp||claims.exp*1000<=Date.now())return;
      const role=saved.role||claims.role;
      if(['owner','manager'].includes(role))activateOwnerWorkspace({token:saved.token,role});
    }catch(error){console.warn('[SWASS] Could not restore dashboard session:',error?.message||error);}
  }
  restoreDashboardSession();
  window.addEventListener('swass:sale-issued',()=>{void loadDashboard();});
  window.addEventListener('swass:logout',()=>{state.token=null;state.role=null;state.lastDashboardData=null;try{sessionStorage.removeItem(DASHBOARD_CACHE_KEY);}catch{}$('owner-dashboard-view').classList.add('hidden');});
  // Refresh the dashboard automatically while the workspace is open. Avoid
  // background traffic when the tab is hidden or the device is offline.
  window.setInterval(()=>{if(state.token&&document.visibilityState==='visible'&&navigator.onLine){void loadDashboard();}},DASHBOARD_REFRESH_MS);
  window.addEventListener('online',()=>{if(state.token)void loadDashboard();});
  $('refresh-btn').addEventListener('click',loadDashboard);
  $('mpesa-purpose').addEventListener('change',()=>{const subscription=$('mpesa-purpose').value==='subscription';$('topup-amount-wrap').classList.toggle('hidden',subscription);$('plan-wrap').classList.toggle('hidden',!subscription);});
  $('mpesa-form').addEventListener('submit',async ev=>{ev.preventDefault();const message=$('mpesa-message');message.textContent='Requesting payment prompt…';try{const purpose=$('mpesa-purpose').value;const payload={purpose,phone:$('mpesa-phone').value.trim()};if(purpose==='wallet_topup')payload.amountKes=Number($('topup-amount').value);else payload.plan=$('subscription-plan').value;const result=await request('/api/v1/mpesa/stk-push',{method:'POST',body:JSON.stringify(payload)});message.textContent=`STK prompt requested for ${money(result.amountKes)}. Enter your M-Pesa PIN on your phone. Checking payment status…`;let attempts=0;const check=async()=>{try{const status=await request(`/api/v1/mpesa/payments/${result.paymentId}`);if(status.status==='success'){message.textContent=`Payment confirmed. M-Pesa receipt: ${status.receiptNumber||'recorded'}.`;await loadDashboard();return;}if(status.status==='failed'){message.textContent='Payment was not completed. You can try again.';return;}attempts++;if(attempts<12){setTimeout(check,5000);}else{message.textContent=`Payment is still pending. Use Refresh status later. Payment reference: ${result.paymentId}`;}}catch(e){message.textContent=e.message;}};await check();}catch(e){message.textContent=e.message;}});
  $('crm-refresh').addEventListener('click',loadCustomers);$('crm-search-btn').addEventListener('click',loadCustomers);$('crm-search').addEventListener('keydown',ev=>{if(ev.key==='Enter'){ev.preventDefault();loadCustomers();}});
  $('expense-form').addEventListener('submit',async ev=>{ev.preventDefault();$('expense-message').textContent='Saving…';try{await request('/api/v1/dashboard/expenses',{method:'POST',body:JSON.stringify({amountKes:Number($('expense-amount').value),category:$('expense-category').value.trim(),note:$('expense-note').value.trim()||undefined})});$('expense-form').reset();$('expense-message').textContent='Expense saved.';await loadDashboard();}catch(e){$('expense-message').textContent=e.message;}});
  const themeKey='swass-dashboard-theme';
  function applyDashboardTheme(dark){
    document.body.classList.toggle('dashboard-dark',dark);
    $('theme-toggle').textContent=dark?'☀ Light mode':'☾ Dark mode';
    $('theme-toggle').setAttribute('aria-pressed',String(dark));
  }
  applyDashboardTheme(localStorage.getItem(themeKey)==='dark');
  $('theme-toggle').addEventListener('click',()=>{
    const dark=!document.body.classList.contains('dashboard-dark');
    applyDashboardTheme(dark);
    localStorage.setItem(themeKey,dark?'dark':'light');
  });
  function updateNetworkStatus(){
    const online=navigator.onLine;
    $('network-status').classList.toggle('offline',!online);
    $('network-status').innerHTML=online?'<i></i> Online':'<i></i> Offline · Sync unavailable';
  }
  window.addEventListener('online',updateNetworkStatus);
  window.addEventListener('offline',updateNetworkStatus);
  updateNetworkStatus();
  // Menu search visibly filters the single dashboard's navigation links.
  $('workspace-search').addEventListener('input',()=>{
    const q=$('workspace-search').value.trim().toLowerCase();
    document.querySelectorAll('.dashboard-sidebar .sidebar-link').forEach(link=>{
      const haystack=(link.textContent+' '+(link.dataset.search||'')).toLowerCase();
      link.classList.toggle('hidden',!!q&&!haystack.includes(q));
    });
  });
  document.querySelectorAll('.dashboard-sidebar .sidebar-link').forEach(link=>{
    link.addEventListener('click',()=>{
      document.querySelectorAll('.dashboard-sidebar .sidebar-link').forEach(item=>item.classList.remove('active'));
      link.classList.add('active');
    });
  });
  if(!API) notice('API address is not configured in frontend/config.js.',true);
  // Authentication is provided by the single till login.
})();
