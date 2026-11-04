(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const API = (window.SWASS_API_URL || '').replace(/\/$/, '');
  const state = { token: null, role: null };
  const money = n => `KSh ${Number(n || 0).toLocaleString('en-KE')}`;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function request(path, options={}) {
    const res = await fetch(`${API}${path}`, { ...options, headers:{'Content-Type':'application/json', ...(state.token?{Authorization:`Bearer ${state.token}`}:{})} });
    const data = await res.json().catch(()=>({})); if(!res.ok) throw new Error(data.message || `Request failed (${res.status})`); return data;
  }
  function showLogin(){ $('login-view').classList.remove('hidden'); $('dashboard-view').classList.add('hidden'); $('logout-btn').classList.add('hidden'); }
  function showDashboard(){ $('login-view').classList.add('hidden'); $('dashboard-view').classList.remove('hidden'); $('logout-btn').classList.remove('hidden'); $('user-label').textContent=state.role; }
  function notice(msg,error=false){$('notice').textContent=msg;$('notice').classList.remove('hidden');$('notice').style.background=error?'#fff0ef':'#eef8f0';$('notice').style.color=error?'#a12b22':'#21643a';}
  function periodQuery(){const p=new URLSearchParams();if($('date-from').value)p.set('from',$('date-from').value);if($('date-to').value)p.set('to',$('date-to').value);return p.toString()?`?${p}`:'';}
  async function loadDashboard(){
    try {
      const data=await request(`/api/v1/dashboard/summary${periodQuery()}`); const s=data.sales,i=data.inventory,e=data.expenses;
      $('m-sales').textContent=money(s.salesKes);$('m-transactions').textContent=`${s.transactions} transactions`;
      $('m-profit').textContent=money(s.grossProfitKes);$('m-expenses').textContent=money(s.expensesKes);$('m-expense-count').textContent=`${e.count} entries`;$('m-net').textContent=money(s.estimatedNetOperatingKes);
      $('m-products').textContent=i.productCount;$('m-low').textContent=`${i.lowStockCount} need restocking`;$('m-stock-cost').textContent=money(i.stockCostKes);$('m-stock-retail').textContent=`Retail value: ${money(i.stockRetailKes)}`;$('m-discounts').textContent=money(s.discountsKes);
      $('m-wallet').textContent=money(data.subscription?.balanceKes||0);$('m-subscription').textContent=data.subscription?`${data.subscription.plan} plan · ${data.subscription.status}`:'No subscription details';
      renderDaily(data.daily||[]);renderCashiers(data.cashiers||[]);await loadExpenses();$('notice').classList.add('hidden');
    } catch(err){notice(err.message,true);}
  }
  function renderDaily(rows){const max=Math.max(1,...rows.map(r=>Number(r.salesKes)));$('daily-chart').innerHTML=rows.length?rows.map(r=>{const h=Math.max(3,Number(r.salesKes)/max*125);return `<div class="day-bar" title="${esc(r.day)} · ${money(r.salesKes)}"><small>${money(r.salesKes)}</small><i style="height:${h}px"></i><b>${new Date(`${r.day}T00:00:00`).toLocaleDateString('en-KE',{day:'numeric',month:'short'})}</b></div>`;}).join(''):'<p class="muted">No sales data for this period.</p>';}
  function renderCashiers(rows){$('cashier-rows').innerHTML=rows.length?rows.map(r=>`<tr><td>${esc(r.name)}</td><td>${r.transactions}</td><td>${money(r.salesKes)}</td></tr>`).join(''):'<tr><td colspan="3">No cashier sales for this period.</td></tr>';}
  async function loadExpenses(){const data=await request('/api/v1/dashboard/expenses?limit=8');$('expense-list').innerHTML=data.expenses?.length?data.expenses.map(x=>`<div class="expense-row"><div><strong>${esc(x.category)}</strong><small>${new Date(x.spentAt).toLocaleDateString('en-KE')}${x.note?` · ${esc(x.note)}`:''}</small></div><b>${money(x.amountKes)}</b></div>`).join(''):'<p class="muted">No expenses recorded.</p>';}
  $('login-form').addEventListener('submit',async ev=>{ev.preventDefault();$('login-error').textContent='';try{const d=await request('/api/v1/auth/login',{method:'POST',body:JSON.stringify({phone:$('login-phone').value.trim(),password:$('login-password').value})});state.token=d.accessToken;const c=JSON.parse(atob(state.token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));state.role=c.role;if(!['owner','manager'].includes(state.role)){state.token=null;throw new Error('This dashboard is available to business owners and managers only.');}showDashboard();await loadDashboard();}catch(e){$('login-error').textContent=e.message;}});
  $('logout-btn').addEventListener('click',()=>{state.token=null;state.role=null;showLogin();});$('refresh-btn').addEventListener('click',loadDashboard);
  $('mpesa-purpose').addEventListener('change',()=>{const subscription=$('mpesa-purpose').value==='subscription';$('topup-amount-wrap').classList.toggle('hidden',subscription);$('plan-wrap').classList.toggle('hidden',!subscription);});
  $('mpesa-form').addEventListener('submit',async ev=>{ev.preventDefault();const message=$('mpesa-message');message.textContent='Requesting payment prompt…';try{const purpose=$('mpesa-purpose').value;const payload={purpose,phone:$('mpesa-phone').value.trim()};if(purpose==='wallet_topup')payload.amountKes=Number($('topup-amount').value);else payload.plan=$('subscription-plan').value;const result=await request('/api/v1/mpesa/stk-push',{method:'POST',body:JSON.stringify(payload)});message.textContent=`STK prompt requested for ${money(result.amountKes)}. Enter your M-Pesa PIN on your phone. Checking payment status…`;let attempts=0;const check=async()=>{try{const status=await request(`/api/v1/mpesa/payments/${result.paymentId}`);if(status.status==='success'){message.textContent=`Payment confirmed. M-Pesa receipt: ${status.receiptNumber||'recorded'}.`;await loadDashboard();return;}if(status.status==='failed'){message.textContent='Payment was not completed. You can try again.';return;}attempts++;if(attempts<12){setTimeout(check,5000);}else{message.textContent=`Payment is still pending. Use Refresh status later. Payment reference: ${result.paymentId}`;}}catch(e){message.textContent=e.message;}};await check();}catch(e){message.textContent=e.message;}});
  $('expense-form').addEventListener('submit',async ev=>{ev.preventDefault();$('expense-message').textContent='Saving…';try{await request('/api/v1/dashboard/expenses',{method:'POST',body:JSON.stringify({amountKes:Number($('expense-amount').value),category:$('expense-category').value.trim(),note:$('expense-note').value.trim()||undefined})});$('expense-form').reset();$('expense-message').textContent='Expense saved.';await loadDashboard();}catch(e){$('expense-message').textContent=e.message;}});
  if(!API)$('login-error').textContent='Set SWASS_API_URL in frontend/config.js before signing in.';
  showLogin();
})();
