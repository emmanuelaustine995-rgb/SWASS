(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = { token: null, role: null, userName: '', staffTitle: '', userPhotoData: '', userPhone: '', userEmail: '', products: [], cart: new Map(), lastReceipt: null, profileLogoData: undefined, businessProfile: {}, workspaceHistory: [], currentWorkspace: null, posReturnScreen: null };
  const SESSION_KEY = 'swass-auth-session-v1';
  const referralCodeFromUrl = new URLSearchParams(window.location.search).get('ref') || '';
  const SESSION_IDLE_MS = 3 * 60 * 60 * 1000;
  let lastSessionWrite = 0;
  function saveSession(){ if(!state.token)return; const now=Date.now(); localStorage.setItem(SESSION_KEY,JSON.stringify({token:state.token,role:state.role,userName:state.userName,staffTitle:state.staffTitle,userPhotoData:state.userPhotoData,userPhone:state.userPhone,userEmail:state.userEmail,lastActivity:now})); lastSessionWrite=now; }
  function touchSession(){ if(!state.token)return; const now=Date.now(); if(now-lastSessionWrite<30000)return; try{const saved=JSON.parse(localStorage.getItem(SESSION_KEY)||'null');if(saved?.token===state.token){saved.lastActivity=now;localStorage.setItem(SESSION_KEY,JSON.stringify(saved));lastSessionWrite=now;}}catch{localStorage.removeItem(SESSION_KEY);} }
  function clearSession(){ localStorage.removeItem(SESSION_KEY); state.token=null; state.role=null; state.userName=''; state.staffTitle=''; state.userPhotoData=''; state.userPhone=''; state.userEmail=''; state.workspaceHistory=[]; state.currentWorkspace=null; state.posReturnScreen=null; }
  function sessionIsValid(saved){ if(!saved?.token||!Number.isFinite(saved.lastActivity)||Date.now()-saved.lastActivity>SESSION_IDLE_MS)return false; try{const part=saved.token.split('.')[1];const claims=JSON.parse(atob(part.replace(/-/g,'+').replace(/_/g,'/')));return !!claims.exp&&claims.exp*1000>Date.now();}catch{return false;} }
  // Always require an explicit sign-in when the app is opened or refreshed.
  // Do not reveal protected workspaces from a stale browser-cached token.
  function restoreSession(){ clearSession(); showLogin(); }
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
  // AURORA tab warm without sending frequent requests.
  window.setInterval(() => {
    if (document.visibilityState === 'visible') void warmApi();
  }, 10 * 60 * 1000);
  const money = (n) => `KSh ${Number(n || 0).toLocaleString('en-KE')}`;
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random()*16|0; return (c==='x'?r:(r&3|8)).toString(16); }));
  async function request(path, options = {}) {
    touchSession();
    const res = await fetch(`${API}${path}`, { ...options, signal: options.signal || AbortSignal.timeout(75000), headers: { 'Content-Type':'application/json', ...(state.token ? { Authorization:`Bearer ${state.token}` } : {}), ...(options.headers || {}) } });
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
  function showLogin(){
    clearSession();
    document.body.classList.remove('workspace-active');
    // A signed-out visitor must see only the login/registration area.
    const protectedScreens=[
      'welcome-back-banner','pos-view','owner-home','receipts-home','shop-home','owner-dashboard-view',
      'staff-profile-panel','profile-panel','history-panel','owner-customers-section',
      'account-profile-menu','receipt-modal','receipt-recovery-modal','workspace-nav'
    ];
    protectedScreens.forEach(id=>$(id)?.classList.add('hidden'));
    $('login-view')?.classList.remove('hidden');
    ['logout-btn','profile-menu-btn','dashboard-link','workspace-nav','back-to-login-btn'].forEach(id=>$(id)?.classList.add('hidden'));
    $('user-label').textContent='';
    document.querySelectorAll('#workspace-nav button').forEach(button=>button.classList.remove('active'));
  }

  function renderDashboardBusinessProfile(){
    const p=state.businessProfile||{};
    const complete=!!(String(p.businessName||'').trim()&&String(p.businessPhone||'').trim()&&String(p.storeName||'').trim());
    const card=$('dashboard-business-card'),panel=$('profile-panel'),close=$('profile-close'),button=$('dashboard-edit-profile');
    if(!card||!panel)return;
    card.classList.remove('hidden');
    $('dashboard-profile-name').textContent=complete?p.businessName:'Complete your business profile';
    $('dashboard-profile-meta').textContent=complete?[p.storeName,p.businessPhone,p.storeLocation].filter(Boolean).join(' · '):'Add your business name, phone and branch details to set up AURORA.';
    const photo=$('dashboard-profile-image');
    if(p.logoData){photo.src=p.logoData;photo.classList.remove('hidden');}else{photo.removeAttribute('src');photo.classList.add('hidden');}
    const inside=$('dashboard-shop-inside-photo'),outside=$('dashboard-shop-outside-photo');
    if(inside){if(p.shopInsidePhotoData){inside.src=p.shopInsidePhotoData;inside.classList.remove('hidden');}else{inside.removeAttribute('src');inside.classList.add('hidden');}}
    if(outside){if(p.shopOutsidePhotoData){outside.src=p.shopOutsidePhotoData;outside.classList.remove('hidden');}else{outside.removeAttribute('src');outside.classList.add('hidden');}}
    const shopPhotos=$('dashboard-shop-photos');
    if(shopPhotos)shopPhotos.classList.toggle('hidden',!p.shopInsidePhotoData&&!p.shopOutsidePhotoData);
    button.textContent=complete?'Update business profile':'Complete business profile';
    if(close)close.classList.toggle('hidden',!complete);
    // Do not let business completeness hide the profile editor while the Profile tab is open.
    if(document.body.classList.contains('workspace-active') &&
       document.getElementById('owner-dashboard-view')?.classList.contains('profile-workspace-mode')){
      panel.classList.remove('hidden');
    }
  }

  function renderAccountProfile(){
    const role=state.role==='cashier'?'Shop staff / cashier':(state.role||'Account').replace('_',' ');
    $('profile-user-name').textContent=state.userName||'My profile';
    $('profile-user-role').textContent=state.staffTitle||role;
    $('profile-user-fullname').textContent=state.userName||'Name not available';
    $('profile-user-accounttype').textContent=role;
    $('profile-user-phone').textContent=state.userPhone||'Not available';
    $('profile-user-email').textContent=state.userEmail||'Not available';
    $('account-profile-name').textContent=state.userName||'My profile';
    $('account-profile-fullname').textContent=state.userName||'Name not available';
    $('account-profile-role').textContent=state.staffTitle||role;
    $('account-profile-accounttype').textContent=role;
    $('account-profile-phone').textContent=state.userPhone||'Not available';
    $('account-profile-email').textContent=state.userEmail||'Not available';
    const business=state.businessProfile||{};
    const businessRow=$('account-profile-business-row');
    businessRow.classList.toggle('hidden',!['owner','manager','vendor','freelancer'].includes(state.role));
    $('account-profile-business').textContent=business.businessName||'Business details not added';
    const readOnlyProfile=['vendor','freelancer'].includes(state.role);
    $('account-profile-photo-area').classList.toggle('hidden',state.role!=='cashier');
    $('account-profile-business-edit').classList.toggle('hidden',!['owner','manager'].includes(state.role));
    const profileForm=$('profile-form');
    if(profileForm){profileForm.querySelectorAll('input,select,textarea,button').forEach(control=>{control.disabled=readOnlyProfile;});const save=profileForm.querySelector('button[type="submit"]');if(save)save.classList.toggle('hidden',readOnlyProfile);}
    $('profile-panel')?.classList.toggle('profile-readonly',readOnlyProfile);
    $('profile-readonly-note')?.classList.toggle('hidden',!readOnlyProfile);
    $('account-profile-photo-area').classList.toggle('hidden',readOnlyProfile || state.role!=='cashier');
    if(state.userPhotoData)$('staff-profile-preview').src=state.userPhotoData;
    else $('staff-profile-preview').removeAttribute('src');
  }
  $('profile-menu-btn')?.addEventListener('click',()=>{const panel=$('account-profile-menu');const open=panel.classList.contains('hidden');if(open){renderAccountProfile();panel.classList.remove('hidden');$('profile-menu-btn').setAttribute('aria-expanded','true');}else{panel.classList.add('hidden');$('profile-menu-btn').setAttribute('aria-expanded','false');}});
  $('close-account-profile')?.addEventListener('click',()=>{$('account-profile-menu').classList.add('hidden');$('profile-menu-btn').setAttribute('aria-expanded','false');});
  $('account-profile-business-edit')?.addEventListener('click',()=>{$('account-profile-menu').classList.add('hidden');$('profile-menu-btn').setAttribute('aria-expanded','false');showWorkspaceScreen('profile');});
  document.addEventListener('click',e=>{const panel=$('account-profile-menu'),button=$('profile-menu-btn');if(panel&&!panel.classList.contains('hidden')&&!panel.contains(e.target)&&!button?.contains(e.target)){panel.classList.add('hidden');button?.setAttribute('aria-expanded','false');}});
  let staffProfilePhotoDraft=null;
  $('staff-profile-photo')?.addEventListener('change',async e=>{const file=e.target.files?.[0];staffProfilePhotoDraft=null;if(!file)return;try{staffProfilePhotoDraft=await compressLogo(file);$('staff-profile-preview').src=staffProfilePhotoDraft;}catch(err){e.target.value='';$('staff-profile-message').textContent=err.message||'Could not prepare your photo.';}});
  $('save-staff-profile-photo')?.addEventListener('click',async()=>{const btn=$('save-staff-profile-photo'),message=$('staff-profile-message');if(!staffProfilePhotoDraft){message.textContent='Choose a photo first.';return;}btn.disabled=true;message.textContent='Saving your profile photo…';try{const data=await request('/api/v1/staff/profile-photo',{method:'PATCH',body:JSON.stringify({profilePhotoData:staffProfilePhotoDraft})});state.userPhotoData=data.profilePhotoData||staffProfilePhotoDraft;saveSession();const label=$('user-label');label.textContent=state.userName||state.staffTitle||'Shop Attendant';const avatar=document.createElement('img');avatar.src=state.userPhotoData;avatar.alt='Profile photo';avatar.style.cssText='width:30px;height:30px;object-fit:cover;border-radius:50%;vertical-align:middle;margin-right:8px';label.prepend(avatar);message.textContent='Your profile photo has been saved.';renderAccountProfile();}catch(err){message.textContent=err.message||'Could not save your photo.';}finally{btn.disabled=false;}});
  async function loadStaffSalesSummary(){
    const panel=$('staff-sales-summary');
    if(!panel||!['cashier','vendor','freelancer'].includes(state.role))return;
    try{
      const data=await request('/api/v1/dashboard/staff-summary');
      const s=data.staff||{};
      $('staff-today-sales').textContent=money(s.todaySalesKes);
      $('staff-today-transactions').textContent=Number(s.todayTransactions||0)+' receipts today';
      $('staff-total-sales').textContent=money(s.salesKes);
      $('staff-total-transactions').textContent=Number(s.transactions||0)+' receipts recorded';
    }catch(error){
      $('staff-today-sales').textContent='Unavailable';
      $('staff-today-transactions').textContent=error.message||'Could not load today’s sales';
    }
  }

  async function loadPlatformReferralAdmin(){
    const list=$('platform-referral-admin-list'),message=$('platform-referral-admin-message');
    if(!list||state.role!=='super_admin')return;
    message.textContent='Loading withdrawal requests…';
    try{
      const data=await request('/api/v1/platform-finance/referral-withdrawals');
      list.replaceChildren();
      if(!data.withdrawals?.length){message.textContent='There are no referral withdrawal requests yet.';return;}
      message.textContent=data.withdrawals.length+' withdrawal request(s).';
      data.withdrawals.forEach(item=>{
        const card=document.createElement('article');card.className='platform-referral-request';
        const title=document.createElement('div');title.className='platform-referral-request-title';
        const name=document.createElement('strong');name.textContent=item.businessName||'Referrer';
        const amount=document.createElement('strong');amount.textContent=money(item.amountKes);
        title.append(name,amount);card.append(title);
        const meta=document.createElement('p');meta.className='muted small';
        meta.textContent='M-Pesa: '+item.payoutPhone+' · '+new Date(item.createdAt).toLocaleString('en-KE')+' · '+item.status;
        card.append(meta);
        if(item.payoutReference){const ref=document.createElement('p');ref.className='muted small';ref.textContent='Transfer reference: '+item.payoutReference;card.append(ref);}
        const actions=document.createElement('div');actions.className='platform-referral-actions';
        if(item.status==='pending'){
          const approve=document.createElement('button');approve.className='btn btn-primary';approve.textContent='Approve';approve.addEventListener('click',()=>updatePlatformWithdrawal(item.id,'approved'));
          const reject=document.createElement('button');reject.className='btn btn-light';reject.textContent='Reject';reject.addEventListener('click',()=>updatePlatformWithdrawal(item.id,'rejected'));
          actions.append(approve,reject);
        }else if(item.status==='approved'){
          const reference=document.createElement('input');reference.type='text';reference.maxLength=120;reference.placeholder='M-Pesa / bank transfer reference';reference.setAttribute('aria-label','Transfer reference');
          const paid=document.createElement('button');paid.className='btn btn-primary';paid.textContent='Mark paid';paid.addEventListener('click',()=>updatePlatformWithdrawal(item.id,'paid',reference.value));
          actions.append(reference,paid);
        }
        if(actions.childElementCount)card.append(actions);
        list.append(card);
      });
    }catch(error){message.textContent=error.message||'Could not load referral withdrawals.';}
  }
  async function updatePlatformWithdrawal(id,status,payoutReference=''){
    const message=$('platform-referral-admin-message');
    try{
      const result=await request('/api/v1/platform-finance/referral-withdrawals/'+encodeURIComponent(id),{
        method:'PATCH',body:JSON.stringify({status,payoutReference})
      });
      message.textContent=result.note||'Withdrawal updated.';
      await loadPlatformReferralAdmin();
    }catch(error){message.textContent=error.message||'Could not update withdrawal.';}
  }
  $('platform-referral-refresh')?.addEventListener('click',()=>void loadPlatformReferralAdmin());
  async function loadOwnerReferralSummary(){
    const card=$('referral-card');
    if(!card)return;
    card.classList.toggle('hidden',state.role!=='owner');
    if(state.role!=='owner')return;
    try{
      const data=await request('/api/v1/referrals/summary');
      $('referral-total').textContent=Number(data.totalReferrals||0).toLocaleString('en-KE');
      $('referral-active').textContent=Number(data.activeReferrals||0).toLocaleString('en-KE');
      $('referral-earned').textContent=Math.floor(Math.max(0,Number(data.earnedKes)||0)/4).toLocaleString('en-KE');
      $('referral-available').textContent=money(data.availableKes);
      if($('referral-remainder'))$('referral-remainder').textContent=money(data.rewardRemainderKes);
      $('referral-receipts-available').textContent=Math.floor(Math.max(0,Number(data.availableKes)||0)/4).toLocaleString('en-KE');
      $('referral-link').value=data.referralLink||'';
      $('referral-message').textContent='Earn 50% after a referred shop owner’s first successful subscription and 50% of each paid KSh 50 vendor activation. Every full KSh 4 redeems one receipt; any smaller balance stays in your reward balance.';
      const history=await request('/api/v1/referrals/transactions');
      const earningsList=$('referral-earning-history');
      if(earningsList){
        earningsList.replaceChildren();
        if(!history.earnings?.length){const empty=document.createElement('p');empty.className='muted small';empty.textContent='No referral rewards yet.';earningsList.append(empty);}
        else history.earnings.forEach(item=>{
          const row=document.createElement('div');row.className='referral-history-row';
          const detail=document.createElement('span');detail.textContent=(item.description||'Referral reward')+' · '+new Date(item.createdAt).toLocaleDateString('en-KE');
          const amount=document.createElement('strong');amount.textContent='+'+money(item.amountKes);
          row.append(detail,amount);earningsList.append(row);
        });
      }
      const list=$('referral-redemption-history');
      if(list){
        list.replaceChildren();
        if(!history.redemptions?.length){const empty=document.createElement('p');empty.className='muted small';empty.textContent='No receipt-credit redemptions yet.';list.append(empty);}
        else history.redemptions.forEach(item=>{
          const row=document.createElement('div');row.className='referral-history-row';
          const detail=document.createElement('span');detail.textContent='Redeemed to receipt wallet · '+new Date(item.createdAt).toLocaleDateString('en-KE');
          const amount=document.createElement('strong');amount.textContent=money(item.amountKes);
          row.append(detail,amount);list.append(row);
        });
      }
    }catch(error){$('referral-message').textContent=error.message||'Referral details could not be loaded.';}
  }
  $('referral-share')?.addEventListener('click',async()=>{
    const link=$('referral-link')?.value;if(!link)return;
    try{
      if(navigator.share)await navigator.share({title:'Join AURORA E-RECEIPT',text:'Register with my referral link and manage your business receipts.',url:link});
      else{await navigator.clipboard.writeText(link);$('referral-message').textContent='Referral link copied. Share it with your friends.';}
    }catch(error){if(error.name!=='AbortError')$('referral-message').textContent='Could not share the link. Copy it from the box above.';}
  });
  $('referral-redeem')?.addEventListener('click',async()=>{
    const button=$('referral-redeem');button.disabled=true;$('referral-message').textContent='Redeeming your referral rewards…';
    try{
      const result=await request('/api/v1/referrals/redeem',{method:'POST',body:JSON.stringify({})});
      $('referral-message').textContent=`${Number(result.receiptCreditsAdded||0).toLocaleString('en-KE')} receipts redeemed (${money(result.amountKes)}). ${money(result.remainingRewardBalanceKes)} remains in your referral reward balance.`;
      await loadOwnerReferralSummary();
      await loadOwnerHomeSummary();
    }catch(error){$('referral-message').textContent=error.message||'Could not redeem referral rewards.';}
    finally{button.disabled=false;}
  });
  async function loadOwnerHomeSummary(){
    if(!['owner','manager','vendor','freelancer'].includes(state.role))return;
    void loadOwnerReferralSummary();
    $('owner-home-title').textContent=state.businessProfile?.businessName||'Business overview';
    $('owner-home-subtitle').textContent=state.businessProfile?.storeName||'Your business workspace at a glance.';

  }

  function syncGlobalBackButton(){
    const button=$('global-back-btn');if(!button)return;
    const posVisible=!$('pos-view')?.classList.contains('hidden');
    const profileVisible=$('owner-dashboard-view')?.classList.contains('profile-workspace-mode');
    const receiptsVisible=!$('receipts-home')?.classList.contains('hidden');
    const shopVisible=!$('shop-home')?.classList.contains('hidden');
    const secondhandVisible=!$('secondhand-panel')?.classList.contains('hidden');
    const modalOpen=['checkout-modal','receipt-modal','receipt-recovery-modal'].some(id=>$(id)&&!$(id).classList.contains('hidden'));
    const workspaceOpen=!!$('workspace-nav')&&!$('workspace-nav').classList.contains('hidden');
    const nested=modalOpen||secondhandVisible||(posVisible&&$('pos-view')?.classList.contains('workspace-issue-mode'));
    const hasBack=!!state.token&&workspaceOpen&&(nested||state.workspaceHistory.length>0||state.currentWorkspace!=='dashboard');
    button.classList.toggle('hidden',!hasBack);
    const previous=state.workspaceHistory[state.workspaceHistory.length-1];
    button.textContent=modalOpen?'← Back':secondhandVisible?'← Receipts':nested?'← Back':previous?('← '+({dashboard:'Dashboard',receipts:'Receipts',profile:'Profile',shop:'Shop',subscription:'Subscription'}[previous]||'Back')):'← Dashboard';
    button.setAttribute('aria-label',button.textContent.replace('← ','Go back to '));
  }
  function goBackWorkspace(){
    const previous=state.workspaceHistory.pop();
    if(previous){showWorkspaceScreen(previous,{fromBack:true});return true;}
    if(state.currentWorkspace&&state.currentWorkspace!=='dashboard'){showWorkspaceScreen('dashboard',{fromBack:true});return true;}
    return false;
  }
  $('global-back-btn')?.addEventListener('click',()=>{
    const modalIds=['checkout-modal','receipt-modal','receipt-recovery-modal'];
    const openModal=modalIds.map(id=>$(id)).find(el=>el&&!el.classList.contains('hidden'));
    if(openModal){
      if(openModal.id==='checkout-modal'&&!$('checkout-payment-step')?.classList.contains('hidden')){
        $('checkout-payment-step')?.classList.add('hidden');$('checkout-customer-step')?.classList.remove('hidden');syncGlobalBackButton();return;
      }
      openModal.classList.add('hidden');openModal.setAttribute('aria-hidden','true');syncGlobalBackButton();return;
    }
    const secondhand=$('secondhand-panel');
    if(secondhand&&!secondhand.classList.contains('hidden')){
      secondhand.classList.add('hidden');
      $('secondhand-open-card')?.classList.remove('hidden');
      $('secondhand-history')?.classList.add('hidden');
      $('secondhand-saved-record')?.classList.add('hidden');
      syncGlobalBackButton();return;
    }
    if(!$('pos-view')?.classList.contains('hidden')&&$('pos-view')?.classList.contains('workspace-issue-mode')){
      $('pos-view').classList.add('hidden');$('pos-view').classList.remove('workspace-issue-mode');
      if(state.posReturnScreen==='dashboard'&&goBackWorkspace()){state.posReturnScreen=null;return;}
      $('receipts-home')?.classList.remove('hidden');state.posReturnScreen=null;syncGlobalBackButton();return;
    }
    if(!$('shop-home')?.classList.contains('hidden')){
      if($('shop-product-results')&&!$('shop-product-results').classList.contains('hidden')){$('shop-product-results').classList.add('hidden');syncGlobalBackButton();return;}
    }
    goBackWorkspace();syncGlobalBackButton();
  });
  function showWorkspaceScreen(screen,options={}){
    if(!state.token){showLogin();return;}
    document.body.classList.add('workspace-active');
    $('login-view')?.classList.add('hidden');
    $('back-to-login-btn')?.classList.remove('hidden');
    if(!['dashboard','receipts','profile','shop','subscription'].includes(screen))screen='dashboard';
    const previous=state.currentWorkspace;
    if(!options.fromBack&&previous&&previous!==screen){state.workspaceHistory.push(previous);if(state.workspaceHistory.length>30)state.workspaceHistory.shift();}
    state.currentWorkspace=screen;
    try{localStorage.setItem('swass-active-workspace-v1',screen);}catch{}
    const owner=document.getElementById('owner-dashboard-view'),pos=$('pos-view');
    const posGrid=document.querySelector('.pos-grid');
    const history=$('history-panel'),crm=$('owner-customers-section'),lookup=document.querySelector('.customer-lookup-panel');
    // Reset nested panels as well as the outer page. These were previously left visible inside POS/profile containers.
    [history,crm,lookup].forEach(el=>el?.classList.add('hidden'));
    const profile=$('profile-panel'),receiptHome=$('receipts-home'),ownerHome=$('owner-home');
    const dashboardBusinessCard=$('dashboard-business-card');
    const subscriptionHome=$('subscription-home');
    const staffSummary=$('staff-sales-summary');
    // Hide every workspace root before opening exactly one destination.
    // This also prevents content retained by a previous tab from remaining visible.
    [dashboardBusinessCard,ownerHome,receiptHome,pos,owner,$('platform-referral-admin'),$('shop-home'),subscriptionHome,staffSummary,$('staff-profile-panel'),$('account-profile-menu')].forEach(el=>el?.classList.add('hidden'));
    dashboardBusinessCard?.classList.add('hidden');
    pos?.classList.remove('profile-workspace-mode');
    owner?.classList.remove('profile-workspace-mode');
    [history,crm,lookup,receiptHome,ownerHome,profile,$('platform-referral-admin'),$('shop-home'),subscriptionHome].forEach(el=>el?.classList.add('hidden'));
    owner?.classList.add('hidden');
    pos?.classList.add('hidden');
    document.getElementById('account-profile-menu')?.classList.add('hidden');
    document.getElementById('staff-profile-panel')?.classList.add('hidden');
    staffSummary?.classList.add('hidden');
    if(screen==='dashboard'){
      dashboardBusinessCard?.classList.remove('hidden');
      if(state.role==='super_admin'){
        dashboardBusinessCard?.classList.add('hidden');
        $('platform-referral-admin')?.classList.remove('hidden');
        void loadPlatformReferralAdmin();
      }else if(['owner','manager','vendor','freelancer'].includes(state.role)){
        ownerHome?.classList.remove('hidden');
        void loadOwnerHomeSummary();
      }else{
        staffSummary?.classList.remove('hidden');
        void loadStaffSalesSummary();
      }
    }else if(screen==='subscription'){
      if(!['owner','manager'].includes(state.role)){
        showNotice('Subscription and payment management is available to the business owner or manager.',true);
        screen='dashboard';
        ownerHome?.classList.remove('hidden');
        void loadOwnerHomeSummary();
      }else{
        subscriptionHome?.classList.remove('hidden');
        syncTumaFields();
      }
    }else if(screen==='receipts'){
      receiptHome?.classList.remove('hidden');
      if(state.role==='cashier'){staffSummary?.classList.remove('hidden');void loadStaffSalesSummary();}
      $('open-recover-receipt')?.classList.remove('hidden');
    }else if(screen==='shop'){
      $('shop-home')?.classList.remove('hidden');
      const isShopOwner = state.role === 'owner';
      $('secondhand-panel')?.classList.add('hidden');
      $('secondhand-panel')?.classList.add('hidden');
      document.querySelector('#shop-home > .shop-directory-card')?.classList.remove('hidden');
      $('shop-add-products')?.classList.toggle('hidden', !isShopOwner);
      $('shop-owner-note')?.classList.toggle('hidden', isShopOwner);
      if($('shop-directory-title'))$('shop-directory-title').textContent=isShopOwner?'Add Products':'Search Products';
      if($('shop-product-results'))$('shop-product-results').classList.add('hidden');
    }else if(screen==='profile'){
      renderAccountProfile();
      if(['owner','manager','vendor','freelancer'].includes(state.role)){
        dashboardBusinessCard?.classList.add('hidden');
        // Profile is a separate workspace, not part of the receipt/POS screen.
        // Show its own container directly below the E-RECEIPT header.
        pos?.classList.add('hidden');
        pos?.classList.remove('profile-workspace-mode');
        owner?.classList.remove('hidden');
        owner?.classList.add('profile-workspace-mode');
        // Profile has only its business, account and (for owners) team cards.
        owner?.querySelectorAll(':scope > *:not(#profile-panel):not(#owner-staff-area)').forEach(el=>el.classList.add('hidden'));
        owner?.querySelector('#owner-staff-area')?.classList.toggle('hidden',state.role!=='owner');
        profile?.classList.remove('hidden');
        // The dashboard and profile share this scroll container. Always reset
        // every nested scroll position when opening Profile so it starts at
        // the top instead of inheriting the dashboard's previous scroll.
        if(owner) owner.scrollTop=0;
        if(profile) profile.scrollTop=0;
        requestAnimationFrame(()=>{
          if(owner) owner.scrollTop=0;
          if(profile) profile.scrollTop=0;
          window.scrollTo(0,0);
        });
        void loadBusinessProfile().then(()=>renderAccountProfile()).catch(err=>showNotice('Business details could not be loaded. '+(err.message||''),true));
      }else{
        document.getElementById('staff-profile-panel')?.classList.remove('hidden');
      }
    }
    document.querySelectorAll('#workspace-nav button').forEach(b=>b.classList.toggle('active',b.dataset.workspace===screen));
    syncGlobalBackButton();
  }

  function showPOS(){ if(!state.token){showLogin();return;} document.body.classList.add('workspace-active'); $('login-view').classList.add('hidden'); $('back-to-login-btn')?.classList.remove('hidden'); $('pos-view').classList.remove('hidden'); $('welcome-back-banner')?.classList.add('hidden'); $('profile-menu-btn')?.classList.remove('hidden'); $('logout-btn')?.classList.remove('hidden'); const label=$('user-label');label.textContent=state.userName||state.staffTitle||(state.role==='cashier'?'Shop Attendant':state.role?state.role.replace('_',' '):'Staff');if(state.userPhotoData){const avatar=document.createElement('img');avatar.src=state.userPhotoData;avatar.alt='Profile photo';avatar.style.cssText='width:30px;height:30px;object-fit:cover;border-radius:50%;vertical-align:middle;margin-right:8px';label.prepend(avatar);} $('dashboard-link').classList.toggle('hidden', !['owner','manager','vendor','freelancer'].includes(state.role));$('workspace-nav').classList.remove('hidden');syncGlobalBackButton();  }
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
  async function openReceiptPdf(receiptId){
    const pdfWindow=window.open('about:blank','_blank');
    if(!pdfWindow){showNotice('Allow pop-ups to open the receipt PDF.',true);return;}
    pdfWindow.document.title='AURORA E-RECEIPT';
    try{
      const response=await fetch(API+'/api/v1/receipts/'+encodeURIComponent(receiptId)+'/pdf',{
        method:'GET',headers:{Authorization:'Bearer '+state.token},cache:'no-store'
      });
      if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.message||'Could not open the receipt PDF.');}
      const blob=await response.blob();
      pdfWindow.location.href=URL.createObjectURL(blob);
    }catch(error){pdfWindow.close();showNotice(error.message||'Could not open the receipt PDF.',true);}
  }
  async function loadReceiptHistory(){
    $('history-error').textContent='';$('history-list').innerHTML='<div class="empty">Loading receipts…</div>';
    const p=new URLSearchParams();const q=$('history-search').value.trim();const from=$('history-from').value;const to=$('history-to').value;
    if(q)p.set('q',q);if(from)p.set('from',from);if(to)p.set('to',to);p.set('limit','50');
    try{const d=await request('/api/v1/receipts?'+p.toString());const rows=d.receipts||[];
      if(!rows.length){$('history-list').innerHTML='<div class="empty">No receipts match your search.</div>';return;}
      $('history-list').innerHTML=rows.map(r=>'<article class="history-row"><div class="history-row-top"><strong>'+escapeHtml(r.receiptNo)+'</strong><strong>'+money(r.totalKes)+'</strong></div><div class="history-row-meta">'+escapeHtml(new Date(r.issuedAt).toLocaleString('en-KE'))+' · '+escapeHtml(r.status)+' · '+escapeHtml(String(r.paymentMethod||'').toUpperCase())+'</div><div class="history-row-meta">Sales agent: '+escapeHtml(r.cashier?.name||'Staff')+'</div><div class="history-row-meta">PDF delivery · Email: '+escapeHtml(r.delivery?.email||'not requested')+' · WhatsApp: '+escapeHtml(r.delivery?.whatsapp||'not requested')+'</div><div class="history-row-meta">'+(r.customer?escapeHtml(r.customer.fullName)+' · '+escapeHtml(r.customer.phone)+(r.customer.nationalIdLast4?' · ID ending '+escapeHtml(r.customer.nationalIdLast4):''):'Walk-in customer')+'</div><div class="history-row-items">'+(r.items||[]).map(i=>escapeHtml(i.name)+' × '+Number(i.qty)+(i.serialNo?' · IMEI: '+escapeHtml(i.serialNo):'')).join(' · ')+'</div><button type="button" class="btn btn-light btn-small" data-view-pdf="'+escapeHtml(r.id)+'">View / print original PDF</button></article>').join('');
    }catch(e){$('history-list').innerHTML='';$('history-error').textContent=e.message||'Could not load receipt history.';}
  }
  async function loadBusinessProfile(){const d=await request('/api/v1/business/profile');const p=d.profile||{};state.businessProfile=p;state.shopInsidePhotoDraft=undefined;state.shopOutsidePhotoDraft=undefined;if(!state.userName){state.userName=p.ownerFullName||p.ownerName||p.fullName||p.name||'';if(state.userName)saveSession();}$('profile-business-name').value=p.businessName||'';$('profile-business-phone').value=p.businessPhone||'';$('profile-business-email').value=p.businessEmail||'';$('profile-store-name').value=p.storeName||'';$('profile-store-location').value=p.storeLocation||'';$('profile-legal-name').value=p.legalName||'';$('profile-house-name').value=p.houseName||'';$('profile-floor').value=p.floor||'';$('profile-house-number').value=p.houseNumber||'';$('profile-website').value=p.websiteUrl||'';$('profile-kra-pin').value=p.kraPin||'';$('profile-registration-code').value=p.registrationCode||'';$('profile-outlet-id').value=p.outletId||'';$('profile-terminal-number').value=p.terminalNumber||'';$('profile-receipt-header').value=p.receiptHeader||'';$('profile-receipt-footer').value=p.receiptFooter||'';state.profileLogoData=p.logoData||undefined;const img=$('logo-preview');if(state.profileLogoData){img.src=state.profileLogoData;img.classList.remove('hidden');}else{img.removeAttribute('src');img.classList.add('hidden');}const inside=$('profile-shop-inside-preview'),outside=$('profile-shop-outside-preview');if(inside){if(p.shopInsidePhotoData){inside.src=p.shopInsidePhotoData;inside.classList.remove('hidden');}else{inside.removeAttribute('src');inside.classList.add('hidden');}}if(outside){if(p.shopOutsidePhotoData){outside.src=p.shopOutsidePhotoData;outside.classList.remove('hidden');}else{outside.removeAttribute('src');outside.classList.add('hidden');}}renderDashboardBusinessProfile();}
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
  const staffInviteForm=$('staff-invite-form');
  const showStaffInvite=$('show-staff-invite-form');
  const cancelStaffInvite=$('cancel-staff-invite');
  const setStaffInviteOpen=open=>{staffInviteForm?.classList.toggle('hidden',!open);if(showStaffInvite){showStaffInvite.textContent=open?'Close invitation form':'＋ Send invitation';showStaffInvite.setAttribute('aria-expanded',String(open));}};
  showStaffInvite?.addEventListener('click',()=>setStaffInviteOpen(staffInviteForm?.classList.contains('hidden')));
  cancelStaffInvite?.addEventListener('click',()=>{staffInviteForm?.reset();setStaffInviteOpen(false);});
  $('staff-invite-form')?.addEventListener('submit',async e=>{
    e.preventDefault();const btn=$('create-staff-invite'),message=$('staff-invite-message');
    btn.disabled=true;btn.textContent='Sending invitation…';message.textContent='Sending a secure invitation email…';
    try{
      const payload={fullName:$('staff-invite-name').value.trim(),email:$('staff-invite-email').value.trim(),phone:$('staff-invite-phone').value.trim(),role:$('staff-invite-role').value};
      const ownerPaymentPhone=$('owner-mpesa-phone')?.value.trim()||'';
      if(payload.role==='Vendor'&&!ownerPaymentPhone)throw new Error('Enter the business owner’s M-Pesa phone number in the dashboard payment section before inviting a Vendor.');
      const data=await request('/api/v1/staff/invitations',{method:'POST',body:JSON.stringify(payload)});
      if(payload.role==='Vendor'){
        message.textContent='Requesting the one-time KSh 50 vendor fee…';
        const pay=await request('/api/v1/mpesa/stk-push',{method:'POST',body:JSON.stringify({purpose:'vendor_fee',invitationId:data.invitation.id,phone:ownerPaymentPhone})});
        message.textContent='KSh 50 STK prompt sent to '+pay.phone+'. Enter your M-Pesa PIN to complete the one-time vendor fee.';
        const deadline=Date.now()+90000;let feePaid=false,feeReceipt='';
        while(Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,3000));const status=await request('/api/v1/mpesa/payments/'+encodeURIComponent(pay.paymentId));if(status.status==='success'){feePaid=true;feeReceipt=status.receiptNumber||'';break;}if(status.status==='failed')break;}
        message.textContent=feePaid?'Vendor fee paid successfully'+(feeReceipt?' · M-Pesa receipt '+feeReceipt:'')+'. The invitation is active.':'Invitation sent, but KSh 50 payment is not confirmed yet. The vendor cannot activate until payment succeeds.';
      }else message.textContent='Freelancer invitation email sent to '+data.invitation.email+'. Freelancers are not charged.';
      $('staff-invite-form').reset();setStaffInviteOpen(false);await loadStaffInvitations();
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
  function addToCart(id){ const p=state.products.find(x=>x.id===id); if(!p)return; const stock=Math.max(0,Number(p.stockQty)||0); const old=state.cart.get(id); if(stock<=0){showNotice('This product is out of stock.',true);return;} if((old?.qty||0)>=stock){showNotice('Available stock limit reached. Update inventory first.',true);return;} state.cart.set(id,{product:p,qty:(old?.qty||0)+1,unitPriceKes:old?.unitPriceKes??Number(p.priceKes),imei:old?.imei||'',directSale:false});hideNotice();renderCart(); }
  function changeQty(id,delta){const row=state.cart.get(id);if(!row)return;const next=row.qty+delta;if(!row.directSale){const stock=Math.max(0,Number(row.product.stockQty)||0);if(next>stock){showNotice('Only '+stock+' units are currently in stock.',true);return;}}if(next<=0)state.cart.delete(id);else row.qty=next;renderCart();}
  function totals(){const subtotal=[...state.cart.values()].reduce((s,r)=>s+Number(r.unitPriceKes??r.product.priceKes)*r.qty,0);const requested=Math.max(0,Math.floor(Number($('discount').value)||0));const discount=Math.min(subtotal,requested);if(requested>subtotal)$('discount').value=String(discount);return {subtotal,discount,total:subtotal-discount};}
  function renderCart(){
    const rows=[...state.cart.entries()];
    $('receipt-add-product-toggle')?.classList.remove('hidden');$('receipt-add-product-toggle').textContent=rows.length?'＋ Add another product':'＋ Add product';
    $('cart-list').innerHTML=rows.length?rows.map(([id,r])=>{
      const serials=Array.isArray(r.serials)?r.serials:[r.imei||''];
      return `<div class="cart-row simple-cart-row"><div><div class="cart-row-name">${escapeHtml(r.product.name)}</div><label class="cart-unit-price">Price (KSh)<input type="number" min="1" max="100000000000" step="1" inputmode="numeric" data-price="${id}" value="${Number(r.unitPriceKes??r.product.priceKes)}" required></label><div class="cart-row-sub cart-line-total">Line total: ${money(Number(r.unitPriceKes??r.product.priceKes)*r.qty)}</div><div class="simple-cart-serial"><input type="text" maxlength="80" data-serial-index="${id}" data-index="0" value="${escapeHtml(serials[0]||'')}" placeholder="IMEI / serial (optional)"><button type="button" class="btn btn-light btn-small" data-scan-serial="${id}" data-index="0">Scan</button></div></div></div>`;
    }).join(''):'<div class="empty">Your sale is empty. Add the first item to begin.</div>';
    const t=totals(); $('subtotal').textContent=money(t.subtotal);$('total').textContent=money(t.total);$('checkout-open').disabled=!rows.length||t.total<0;$('checkout-open').textContent='Continue to customer details';$('checkout-open').classList.remove('hidden');
  }
  function openCheckout(){$('checkout-customer-step')?.classList.remove('hidden');$('checkout-payment-step')?.classList.add('hidden');const items=[...state.cart.values()];if(!items.length){showNotice('Add at least one product before customer details.',true);return;}const invalid=[...$('cart-list').querySelectorAll('[data-price]')].some(input=>!Number.isSafeInteger(Number(input.value))||Number(input.value)<1);if(invalid){showNotice('Enter a valid price for each product before continuing.',true);return;}const needsBuyer=items.some(r=>r.product.requiresBuyerId);$('buyer-id-wrap').classList.remove('hidden');$('buyer-id-note').classList.remove('hidden');$('buyer-id').required=true;$('checkout-total').textContent=money(totals().total);$('receipt-mpesa-amount').value=String(totals().total);$('receipt-mpesa-phone').value=$('buyer-phone').value.trim();$('receipt-mpesa-fields').classList.toggle('hidden',$('payment-method').value!=='mpesa');$('checkout-error').textContent='';const modal=$('checkout-modal');modal.classList.remove('hidden');modal.setAttribute('aria-hidden','false');const card=modal.querySelector('.modal-card');if(card)card.scrollTop=0;syncGlobalBackButton();}
  function makeReceiptMarkup(receipt, sale, customer){
    const business=receipt.business||{};
    const lines=sale.items.map(i=>`<div class="receipt-line"><span><strong>${escapeHtml(i.name)}</strong> × ${i.qty}<br><small>Unit price: ${money(i.price)}${i.serialNo?`<br>IMEI / Serial: ${escapeHtml(i.serialNo)}<br><span id="imei-qr-${sale.items.indexOf(i)}" class="imei-qr"></span>`:''}</small></span><strong>${money(i.price*i.qty)}</strong></div>`).join('');
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
    if(items.some(r=>r.product.requiresBuyerId&&!((Array.isArray(r.serials)&&r.serials.some(v=>String(v||'').trim()))||String(r.imei||'').trim()))){$('checkout-error').textContent='Enter the IMEI / serial number for each item that requires buyer identification.';return;}
    const customer={fullName:$('buyer-name').value.trim(),phone:$('buyer-phone').value.trim(),...($('buyer-email').value.trim()?{email:$('buyer-email').value.trim()}:{}),...($('buyer-id').value.trim()?{nationalId:$('buyer-id').value.trim()}:{})};
    if(!customer.fullName||!customer.phone){ $('checkout-error').textContent='Enter the customer full name and phone number to continue.';return; }
    if(!customer.nationalId){ $('checkout-error').textContent='Enter the customer National ID number before issuing this receipt.';$('buyer-id').focus();return; }
    const saleId=uuid();const payload={clientUuid:saleId,receiptNo:`AR-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${saleId.replace(/-/g,'').slice(0,10).toUpperCase()}`,paymentMethod:$('payment-method').value,issuedAt:new Date().toISOString(),discountKes:t.discount,items:items.flatMap(r=>{const price=Number(r.unitPriceKes??r.product.priceKes),codes=Array.isArray(r.serials)?r.serials.filter(Boolean):[],base=r.directSale?{name:r.product.name,unitPriceKes:price,requiresBuyerId:!!r.product.requiresBuyerId}:{productId:r.product.id,unitPriceKes:price};if(codes.length){const serialLines=codes.map(serialNo=>({...base,qty:1,serialNo}));if(r.qty>codes.length)serialLines.push({...base,qty:r.qty-codes.length});return serialLines;}return [{...base,qty:r.qty,...(r.imei&&r.imei.trim()?{serialNo:r.imei.trim()}: {})}];})};
    payload.customer=customer;
    const btn=$('complete-sale');btn.disabled=true;btn.textContent='Issuing receipt…';$('checkout-error').textContent='';
    try{
      if(payload.paymentMethod==='mpesa'){
        const payPhone=$('receipt-mpesa-phone')?.value.trim()||'';
        const payAmount=Number($('receipt-mpesa-amount')?.value||t.total);
        if(!payPhone)throw new Error('Enter the M-Pesa phone number to receive the STK prompt.');
        if(!Number.isSafeInteger(payAmount)||payAmount!==t.total)throw new Error('The M-Pesa amount must match the receipt total of '+money(t.total)+'.');
        btn.textContent='Requesting STK push…';
        const started=await request('/api/v1/mpesa/stk-push',{method:'POST',body:JSON.stringify({purpose:'receipt_sale',phone:payPhone,amountKes:payAmount})});
        if(!started.paymentId)throw new Error('The payment provider did not return a payment reference. Do not retry until payment status is checked.');
        $('checkout-error').textContent='STK prompt sent to '+started.phone+'. Enter your M-Pesa PIN to pay '+money(started.amountKes)+'.';
        const deadline=Date.now()+120000;let confirmed=false;
        while(Date.now()<deadline){
          await new Promise(resolve=>setTimeout(resolve,3000));
          const status=await request('/api/v1/mpesa/payments/'+encodeURIComponent(started.paymentId));
          if(status.status==='success'){confirmed=true;payload.mpesaReceiptNumber=status.receiptNumber||'';break;}
          if(status.status==='failed')throw new Error('M-Pesa payment was not completed. No receipt has been issued.');
          $('checkout-error').textContent='Waiting for M-Pesa confirmation… Complete the STK prompt on your phone.';
        }
        if(!confirmed)throw new Error('Payment is still pending. No receipt has been issued. Check payment status before trying again.');
      }
      btn.textContent='Issuing receipt…';
      const receipt=await request('/api/v1/receipts',{method:'POST',body:JSON.stringify(payload)});
      state.lastReceipt=receipt; const sale={items:items.flatMap(r=>{const price=Number(r.unitPriceKes??r.product.priceKes);const codes=Array.isArray(r.serials)?r.serials.filter(Boolean):[];if(codes.length){const serialLines=codes.map(serialNo=>({name:r.product.name,qty:1,price,serialNo}));if(r.qty>codes.length)serialLines.push({name:r.product.name,qty:r.qty-codes.length,price,serialNo:null});return serialLines;}return [{name:r.product.name,qty:r.qty,price,serialNo:r.imei&&r.imei.trim()?r.imei.trim():null}];}),subtotal:Number(receipt.subtotalKes??t.subtotal),discount:Number(receipt.discountKes??t.discount),paymentMethod:payload.paymentMethod};
      $('receipt-paper').innerHTML=makeReceiptMarkup(receipt,sale,payload.customer);if(window.QRCode){try{if(receipt.qrToken){const verifyUrl=new URL('verify.html',window.location.href).href+'?token='+encodeURIComponent(receipt.qrToken);new QRCode($('receipt-qr'),{text:verifyUrl,width:116,height:116,correctLevel:QRCode.CorrectLevel.M});}sale.items.forEach((item,index)=>{if(item.serialNo){const target=$('imei-qr-'+index);if(target)new QRCode(target,{text:item.serialNo,width:72,height:72,correctLevel:QRCode.CorrectLevel.M});}});}catch(error){console.warn('Receipt QR rendering failed:',error?.message||'unknown error');}}$('checkout-modal').classList.add('hidden');$('receipt-modal').classList.remove('hidden');state.cart.clear();$('discount').value='0';$('checkout-form').reset();renderCart();const emailStatus=$('receipt-email-status');if(emailStatus){emailStatus.textContent='Email: '+(receipt.emailDelivery?.message||(payload.customer?.email?'Delivery status unavailable.':'No customer email was provided.'))+' WhatsApp: '+(receipt.whatsappDelivery?.message||(payload.customer?.phone?'Delivery status unavailable.':'No customer phone was provided.'));emailStatus.classList.toggle('error',!!((payload.customer?.email&&!receipt.emailDelivery?.sent)||(payload.customer?.phone&&!receipt.whatsappDelivery?.sent)));}window.dispatchEvent(new CustomEvent('swass:sale-issued',{detail:{receiptNo:receipt.receiptNo,totalKes:receipt.totalKes}}));if(state.role==='cashier')await loadStaffSalesSummary();hideNotice();
    }catch(e){$('checkout-error').textContent=e.message;}
    finally{btn.disabled=false;btn.textContent='Issue receipt';}
  }
  // Put the existing M-Pesa subscription/top-up form behind compact dashboard tabs.
  const dashboardPaymentSlot = $('dashboard-payment-form-slot');
  const dashboardPaymentPanel = $('dashboard-payment-panel');
  const existingPaymentCard = $('owner-mpesa-form')?.closest('section') || $('owner-payments-section')?.querySelector(':scope > section:first-child');
  if (dashboardPaymentSlot && existingPaymentCard) dashboardPaymentSlot.appendChild(existingPaymentCard);
  const vendorAccessTab = $('dashboard-vendor-tab');
  if (vendorAccessTab) {
    vendorAccessTab.classList.toggle('hidden', state.role !== 'owner');
    vendorAccessTab.addEventListener('click', () => {
      showWorkspaceScreen('profile');
      const team = $('owner-staff-area');
      if (team) team.open = true;
      setStaffInviteOpen(true);
      $('staff-invite-role').value = 'Vendor';
      $('staff-invite-message').textContent = 'Each Vendor has a one-time KSh 50 activation fee, paid by the business owner through M-Pesa. Freelancers are free.';
      requestAnimationFrame(() => team?.scrollIntoView({behavior:'smooth',block:'center'}));
    });
  }
  document.querySelectorAll('[data-payment-purpose]').forEach(tab => tab.addEventListener('click', () => {
    const purpose = tab.dataset.paymentPurpose;
    const selector = $('owner-mpesa-purpose');
    if (selector) selector.value = purpose;
    if (purpose === 'subscription' && $('owner-subscription-plan')) $('owner-subscription-plan').value = tab.dataset.subscriptionPlan || 'monthly';
    syncTumaFields();
    $('dashboard-payment-intro').textContent = purpose === 'subscription' ? 'Subscription payment: confirm your plan and amount, enter the M-Pesa number, then approve the STK prompt on your phone.' : 'Receipt wallet top-up: enter an amount of at least KSh 4, add your M-Pesa number, then approve the STK prompt on your phone.';
    dashboardPaymentPanel?.classList.remove('hidden');
    document.querySelectorAll('[data-payment-purpose]').forEach(item => item.classList.toggle('active', item === tab));
    dashboardPaymentPanel?.scrollIntoView({behavior:'smooth',block:'nearest'});
    $('owner-mpesa-phone')?.focus({preventScroll:true});
  }));
  $('dashboard-payment-close')?.addEventListener('click', () => {
    dashboardPaymentPanel?.classList.add('hidden');
    document.querySelectorAll('[data-payment-purpose]').forEach(item => item.classList.remove('active'));
  });
  // Tuma subscription and wallet payments
  const tumaForm = $('owner-mpesa-form');
  const tumaPurpose = $('owner-mpesa-purpose');
  const syncTumaFields = () => {
    const isSubscription = tumaPurpose?.value === 'subscription';
    $('owner-topup-amount-wrap')?.classList.toggle('hidden', isSubscription);
    $('owner-plan-wrap')?.classList.toggle('hidden', !isSubscription);
    $('owner-payment-amount-wrap')?.classList.toggle('hidden', !isSubscription);
    const plan = $('owner-subscription-plan')?.value || 'monthly';
    const fixedAmount = plan === 'yearly' ? 900 : 100;
    if ($('owner-payment-amount-display')) $('owner-payment-amount-display').value = fixedAmount.toLocaleString('en-KE');
    const topup = Number($('owner-topup-amount')?.value || 0);
    if (!isSubscription && $('owner-payment-amount-display')) $('owner-payment-amount-display').value = topup.toLocaleString('en-KE');
  };
  if (tumaPurpose) {
    tumaPurpose.addEventListener('change', syncTumaFields);
    $('owner-subscription-plan')?.addEventListener('change', syncTumaFields);
    $('owner-topup-amount')?.addEventListener('input', syncTumaFields);
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
          message.textContent = 'Payment confirmed successfully' + (current.receiptNumber ? ' · M-Pesa receipt: ' + current.receiptNumber : '') + '. Your AURORA subscription or wallet has been updated.';
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

  // Scan an item's QR/barcode with the Android camera, with manual entry as a fallback.
  let imeiScannerStream=null, imeiScannerFrame=0, imeiScannerDetector=null, imeiScannerTarget='';
  function stopImeiScanner(){
    if(imeiScannerFrame)cancelAnimationFrame(imeiScannerFrame);
    imeiScannerFrame=0;
    if(imeiScannerStream)imeiScannerStream.getTracks().forEach(track=>track.stop());
    imeiScannerStream=null;
    const video=$('imei-scanner-video');if(video)video.srcObject=null;
    $('imei-scanner-modal')?.classList.add('hidden');
  }
  function applyScannedImei(value){
    const code=String(value||'').trim().slice(0,80);
    if(!code){$('imei-scanner-message').textContent='Enter or scan a valid code.';return;}
    const directField=$(imeiScannerTarget);
    if(directField && directField.tagName==='INPUT'){
      directField.value=code;
      directField.dispatchEvent(new Event('input',{bubbles:true}));
      // A QR payload may carry a product name or catalogue identifier. A plain
      // IMEI is matched only against products already saved in this business.
      let payload={};try{payload=JSON.parse(code);}catch{}
      const payloadName=payload.productName||payload.product_name||payload.name||payload.model||'';
      const payloadId=payload.productId||payload.product_id||payload.sku||payload.barcode||'';
      const match=state.products.find(p=>{
        const ids=[p.id,p.sku,p.barcode,p.imei,p.serialNumber,p.serialNo,p.serial_number,...(Array.isArray(p.identifiers)?p.identifiers:[])].map(v=>String(v||'').trim().toLowerCase());
        return ids.includes(code.toLowerCase())||(payloadId&&ids.includes(String(payloadId).trim().toLowerCase()));
      });
      const detectedName=String(payloadName||match?.name||match?.productName||'').trim();
      if(detectedName){$('product-name').value=detectedName;if(match?.priceKes&&!$('product-price').value)$('product-price').value=match.priceKes;}
      stopImeiScanner();
      showNotice(detectedName?'Scanned successfully. Product detected: '+detectedName+'.':'IMEI captured. No matching saved product or product name was found in this QR code; enter the product name to continue.',!detectedName);
      return;
    }
    const row=state.cart.get(imeiScannerTarget);
    if(!row){$('imei-scanner-message').textContent='This sale item is no longer in the cart.';return;}
    row.serials=Array.isArray(row.serials)?row.serials:['','',''];
    const slot=Number(window.auroraSerialIndex)||row.serials.findIndex(v=>!String(v||'').trim());
    row.serials[Math.max(0,Math.min(2,slot<0?0:slot))]=code;
    row.imei=row.serials[0]||'';
    const field=$('cart-list').querySelector('[data-serial-index="'+CSS.escape(imeiScannerTarget)+'"][data-index="'+Math.max(0,Math.min(2,slot<0?0:slot))+'"]');
    if(field)field.value=code;
    stopImeiScanner();
    showNotice('Scanned code added to '+row.product.name+'.');
  }
  async function openImeiScanner(productId){
    imeiScannerTarget=productId;
    $('imei-scanner-manual').value='';
    $('imei-scanner-message').textContent='Point your camera at the item QR code or barcode. You can also type the code below.';
    $('imei-scanner-modal').classList.remove('hidden');
    if(!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia){
      $('imei-scanner-message').textContent='Camera scanning is not supported in this browser. Enter the QR/barcode value manually below.';
      return;
    }
    try{
      imeiScannerDetector=new BarcodeDetector({formats:['qr_code','code_128','code_39','ean_13','ean_8','upc_a','upc_e']});
      imeiScannerStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
      const video=$('imei-scanner-video');video.srcObject=imeiScannerStream;await video.play();
      const scanFrame=async()=>{
        if(!imeiScannerStream)return;
        try{const codes=await imeiScannerDetector.detect(video);if(codes.length&&codes[0].rawValue){applyScannedImei(codes[0].rawValue);return;}}
        catch(error){$('imei-scanner-message').textContent='Camera scan failed. You can enter the code manually.';}
        imeiScannerFrame=requestAnimationFrame(scanFrame);
      };
      imeiScannerFrame=requestAnimationFrame(scanFrame);
    }catch(error){
      $('imei-scanner-message').textContent='Camera permission was not granted or the camera is unavailable. Enter the code manually.';
    }
  }
  $('imei-scanner-close')?.addEventListener('click',stopImeiScanner);
  $('imei-scanner-modal')?.addEventListener('click',e=>{if(e.target.id==='imei-scanner-modal')stopImeiScanner();});
  $('imei-scanner-use')?.addEventListener('click',()=>applyScannedImei($('imei-scanner-manual').value));
  $('product-form')?.addEventListener('click',e=>{const scan=e.target.closest('[data-scan-field]');if(scan)openImeiScanner(scan.dataset.scanField);});

  $('customer-lookup-form').addEventListener('submit',lookupCustomer);
  $('customer-lookup-result').addEventListener('click',e=>{
    if(e.target.id==='add-customer-package'){
      openSaleItemForm();
      showNotice('Enter the next item manually. It will be added only to this receipt.');
    }
    if(e.target.id==='register-lookup-customer'){
      $('buyer-name').value='';$('buyer-phone').value=$('lookup-phone').value.trim();$('buyer-email').value='';$('buyer-id').value=$('lookup-national-id').value.trim();
      showNotice('New customer details will be saved when you issue their first receipt. Enter the goods manually, then continue to customer details.');
      openSaleItemForm();
    }
  });
  function openSaleItemForm(){ $('product-form').reset(); $('product-stock').value='1'; $('product-reorder').value='1'; $('product-date').value=new Date().toLocaleString('en-KE'); $('product-error').textContent='';$('product-form').classList.remove('hidden');$('receipt-add-product-toggle')?.setAttribute('aria-expanded','true');$('receipt-add-product-toggle').textContent='Close product form';$('product-form').scrollIntoView({behavior:'smooth',block:'center'}); $('product-name').focus({preventScroll:true}); }
  function closeSaleItemForm(){ $('product-form')?.classList.add('hidden');$('receipt-add-product-toggle')?.setAttribute('aria-expanded','false');$('receipt-add-product-toggle').textContent=state.cart.size?'＋ Add another product':'＋ Add product'; }
  $('receipt-add-product-toggle')?.addEventListener('click',()=>{if($('product-form').classList.contains('hidden'))openSaleItemForm();else closeSaleItemForm();});
  $('add-product-btn')?.addEventListener('click',openSaleItemForm);
  $('product-form').addEventListener('submit',async e=>{
    e.preventDefault(); $('product-error').textContent='';
    const btn=$('product-form').querySelector('button[type="submit"]'); btn.disabled=true; btn.textContent='Adding item…';
    const serialValue=$('product-serial-1').value.trim();
    const serials=serialValue?[serialValue]:[];
    const qty=1,price=Number($('product-price').value);
    if(!Number.isSafeInteger(price)||price<1){$('product-error').textContent='Enter a valid selling price.';btn.disabled=false;btn.textContent='Add product to sale';return;}
    const id='direct-'+uuid(),product={id,name:$('product-name').value.trim(),priceKes:price,costKes:0,stockQty:qty,reorderLevel:0,requiresBuyerId:$('product-buyer-id').checked};
    state.cart.set(id,{product,qty,unitPriceKes:price,serials,imei:serials[0]||'',directSale:true});
    $('product-form').reset();$('product-stock').value='1';$('product-reorder').value='1';
    renderCart();closeSaleItemForm();showNotice('Item added to this receipt. Add another product or continue to customer details.');
    btn.disabled=false;btn.textContent='Add product to sale';
  });
  $('clear-catalogue-btn')?.addEventListener('click',async()=>{
    if(!window.confirm('Clear all current products from this shop catalogue? Previous sales and receipts will be preserved.'))return;
    const btn=$('clear-catalogue-btn');btn.disabled=true;
    try{const result=await request('/api/v1/products/archive-all',{method:'POST',body:JSON.stringify({})});state.products=[];state.cart.clear();renderProducts();renderCart();showNotice(result.message||'Old catalogue cleared. Previous receipts are safe.');}
    catch(err){showNotice(err.message||'Could not clear catalogue.',true);}
    finally{btn.disabled=false;}
  });
  function updateSignupAccountType(){
    if($('reg-account-type'))$('reg-account-type').value='owner';
    $('owner-signup-fields').classList.remove('hidden');
    $('reg-business').required=true;
    $('reg-store').required=true;
    $('reg-password').required=true;
    $('reg-password-field').classList.remove('hidden');
    $('register-submit').textContent='Create business · Send verification code';
  }
  updateSignupAccountType();
  function updateLoginAccountType(){
    const selected = $('login-account-type').value;
    const staffSelected = selected !== 'owner';
    $('owner-register-entry').classList.toggle('hidden', staffSelected);
    document.querySelectorAll('[data-login-role]').forEach(tab=>{
      const active=tab.dataset.loginRole===selected;
      tab.classList.toggle('active',active);
      tab.setAttribute('aria-pressed',String(active));
    });
    if(selected==='customer'){
      $('login-error').textContent='Customer sign-in is not available yet. Customer accounts do not have passwords enabled.';
    }else if($('login-error').textContent.startsWith('Customer sign-in')){
      $('login-error').textContent='';
    }
    if(staffSelected && !$('register-form').classList.contains('hidden')){
      $('register-form').classList.add('hidden');
      $('login-form').classList.remove('hidden');
    }
  }
  $('show-register')?.addEventListener('click',()=>{
    $('login-form').classList.add('hidden');$('password-reset-form')?.classList.add('hidden');$('first-password-form')?.classList.add('hidden');$('owner-register-entry').classList.add('hidden');$('register-form').classList.remove('hidden');$('register-error').textContent='';$('signup-otp-message').textContent='';updateSignupAccountType();
  });
  $('show-login')?.addEventListener('click',()=>{
    $('register-form').classList.add('hidden');$('signup-otp-panel').classList.add('hidden');$('register-fields').classList.remove('hidden');$('register-submit').classList.remove('hidden');$('login-form').classList.remove('hidden');$('owner-register-entry').classList.toggle('hidden',$('login-account-type').value==='staff');$('register-error').textContent='';$('login-error').textContent='';
  });
  $('login-account-type').addEventListener('change', updateLoginAccountType);
  document.querySelectorAll('[data-login-role]').forEach(tab=>tab.addEventListener('click',()=>{ $('login-account-type').value=tab.dataset.loginRole; updateLoginAccountType(); }));
  updateLoginAccountType();
  let signupResendTimer = null;
  let signupResendSeconds = 0;
  function signupPayload(){
    return {
      accountType:'owner',
      businessName:$('reg-business').value.trim(),
      legalName:$('reg-legal-name').value.trim(),businessEmail:$('reg-business-email').value.trim(),
      storeName:$('reg-store').value.trim(),
      storeLocation:$('reg-location').value.trim(),
      houseName:$('reg-house-name').value.trim(),floor:$('reg-floor').value.trim(),houseNumber:$('reg-house-number').value.trim(),websiteUrl:$('reg-website').value.trim(),kraPin:$('reg-kra-pin').value.trim(),
      fullName:$('reg-name').value.trim(),
      phone:$('reg-phone').value.trim(),
      email:$('reg-email').value.trim(),
      password:$('reg-password').value,
      referralCode:referralCodeFromUrl
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
      $('register-error').textContent='Connecting to AURORA…';
      void warmApi();
      $('register-error').textContent='';
      const data=await request('/api/v1/auth/register',{method:'POST',signal:AbortSignal.timeout(150000),body:JSON.stringify(signupPayload())});
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
      $('register-form').reset();
      updateSignupAccountType();
      $('register-fields').classList.remove('hidden');
      $('signup-otp-panel').classList.add('hidden');
      $('register-submit').classList.remove('hidden');
      showPOS();
      publishWorkspaceSession();
      showWorkspaceScreen('dashboard');
      showNotice('Your business account is ready. Subscribe for KSh 100 per month (or KSh 900 per year), then top up your receipt wallet.');
    }catch(err){
      $('signup-otp-message').textContent=err.message||'Verification failed. Check the code and try again.';
    }finally{btn.disabled=false;btn.textContent='Verify phone and create account';}
  });
  $('login-form').addEventListener('submit',async e=>{
    e.preventDefault();
    const button=$('login-form').querySelector('button[type="submit"]');
    $('login-error').textContent='';
    if(button){button.disabled=true;button.textContent='Waking up AURORA…';}
    const loginWait=setTimeout(()=>{if(button&&button.disabled)button.textContent='Still connecting…';},12000);
    let signedIn=false;
    try{
      // Send authentication immediately. The health warm-up runs in the
      // background; waiting for it first doubled the cold-start delay.
      if(button)button.textContent='Signing in…';
      const loginPhone=$('login-phone').value.trim();
      const loginDigits=loginPhone.replace(/\D/g,'');
      if(!/^(?:254\d{9}|0\d{9}|\d{9})$/.test(loginDigits))throw new Error('Enter a valid Kenyan phone number, for example 0712345678.');
      if(!$('login-password').value)throw new Error('Enter your password to sign in.');
      if($('login-account-type').value==='customer')throw new Error('Customer sign-in is not available yet. Please use the shop owner or freelancer account tab.');
      const data=await request('/api/v1/auth/login',{
        method:'POST',
        // Render free instances can take over 50 seconds to wake. Allow enough
        // time for the API to start and complete the database-backed login.
        signal:AbortSignal.timeout(150000),
        body:JSON.stringify({phone:loginPhone,password:$('login-password').value,accountType:$('login-account-type').value})
      });
      if(!data.accessToken)throw new Error('The server did not return a sign-in token. Please try again.');
      const parts=data.accessToken.split('.')[1];
      const claims=JSON.parse(atob(parts.replace(/-/g,'+').replace(/_/g,'/')));
      state.token=data.accessToken;
      state.role=claims.role;
      state.userName=data.user?.fullName||data.user?.name||data.user?.displayName||claims.fullName||claims.name||claims.displayName||claims.firstName||'';state.staffTitle=data.user?.staffTitle||'';state.userPhotoData=data.user?.profilePhotoData||'';state.userPhone=data.user?.phone||$('login-phone').value.trim();state.userEmail=data.user?.email||'';
      if(data.mustChangePassword || claims.mustChangePassword){
        $('login-form').classList.add('hidden');
        $('show-password-reset').parentElement.classList.add('hidden');
        $('first-password-form').classList.remove('hidden');
        $('first-password-message').textContent='Please create your own private password before continuing.';
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
      state.userName='';state.staffTitle='';state.userPhotoData='';state.userPhone='';state.userEmail='';
      $('login-error').textContent=err.message||'Sign-in failed. Check your phone number and password.';
    }finally{
      clearTimeout(loginWait);
      if(button){button.disabled=false;button.textContent='Sign in';}
    }
    if(!signedIn)return;
    // Open the workspace immediately after authentication. No product catalogue is loaded.
    const landingScreen = 'dashboard';
    showWorkspaceScreen(landingScreen);
    const backgroundLoads = [];
    if(['owner','manager','vendor','freelancer'].includes(state.role)){
      backgroundLoads.push(loadBusinessProfile().catch(err => {
        if(err.status === 402){
          showWorkspaceScreen('profile');
          showNotice('AURORA is locked until you subscribe. Open Wallet & Subscription in your profile to continue.');
        } else {
          showNotice('You are signed in, but the business profile could not be loaded. '+(err.message||''),true);
        }
      }));
    }
    void Promise.allSettled(backgroundLoads);
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
  async function loadOwnerStaffPerformance(){
    const body=$('owner-cashier-rows'),message=$('owner-staff-performance-message');
    if(!body||!['owner','manager','vendor','freelancer'].includes(state.role))return;
    body.innerHTML='<tr><td colspan="5">Loading staff performance…</td></tr>';
    message.textContent='Loading today and month-to-date sales…';
    try{
      const data=await request('/api/v1/dashboard/summary');
      const rows=Array.isArray(data.cashiers)?data.cashiers:[];
      if(!rows.length){body.innerHTML='<tr><td colspan="5">No staff sales records yet.</td></tr>';message.textContent='Staff performance will appear here after staff issue receipts.';return;}
      body.innerHTML=rows.map(s=>'<tr><td>'+escapeHtml(s.name||'Staff')+'</td><td>'+Number(s.todayTransactions||0).toLocaleString('en-KE')+'</td><td>'+money(s.todaySalesKes)+'</td><td>'+Number(s.mtdTransactions||0).toLocaleString('en-KE')+'</td><td>'+money(s.mtdSalesKes)+'</td></tr>').join('');
      message.textContent='Updated just now · MTD means from the 1st of this month to today.';
    }catch(error){
      body.innerHTML='<tr><td colspan="5">Performance could not be loaded.</td></tr>';
      message.textContent=error.message||'Could not load staff performance.';
    }
  }
  document.getElementById('owner-staff-area')?.addEventListener('click',e=>{
    const tab=e.target.closest('[data-staff-tab]');if(!tab)return;
    const performance=tab.dataset.staffTab==='performance';
    document.getElementById('staff-invitations-panel')?.classList.toggle('hidden',performance);
    document.getElementById('owner-staff-performance')?.classList.toggle('hidden',!performance);
    document.querySelectorAll('[data-staff-tab]').forEach(b=>{const active=b===tab;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));});
    if(performance)void loadOwnerStaffPerformance();
  });
  $('workspace-nav').addEventListener('click',e=>{const b=e.target.closest('[data-workspace]');if(b)showWorkspaceScreen(b.dataset.workspace);});
  $('owner-home-subscription')?.addEventListener('click',()=>showWorkspaceScreen('subscription'));
  $('back-to-receipts').addEventListener('click',()=>{
    $('pos-view').classList.add('hidden');
    $('pos-view').classList.remove('workspace-issue-mode');
    if(state.posReturnScreen==='dashboard'&&goBackWorkspace()){state.posReturnScreen=null;return;}
    $('receipts-home').classList.remove('hidden');
    state.posReturnScreen=null;
    syncGlobalBackButton();
  });
  $('open-issue-receipt').addEventListener('click',()=>{
    $('receipts-home').classList.add('hidden');$('pos-view').classList.remove('hidden');$('pos-view').classList.add('workspace-issue-mode');state.posReturnScreen='receipts';
    document.querySelector('.pos-grid')?.classList.remove('hidden');$('history-panel').classList.add('hidden');$('owner-customers-section')?.classList.add('hidden');document.querySelector('.customer-lookup-panel')?.classList.add('hidden');$('products-panel').classList.add('hidden');
    closeSaleItemForm();$('checkout-open').disabled=!state.cart.size;
    syncGlobalBackButton();
  });
  $('open-recover-receipt').addEventListener('click',()=>{window.location.href='recover.html';});
  $('open-special-amendment')?.addEventListener('click',()=>{
    if(state.role!=='owner'){showNotice('Only the shop owner can amend a saved Second-Hand Special Receipt.',true);return;}
    showWorkspaceScreen('receipts');
    $('secondhand-open-card')?.click();
    $('secondhand-history-toggle')?.click();
    $('secondhand-history')?.scrollIntoView({behavior:'smooth',block:'start'});
  });
  document.querySelector('.dashboard-sidebar')?.addEventListener('click',e=>{const link=e.target.closest('.sidebar-link');if(!link)return;const screen=link.dataset.screen||(link.getAttribute('href')==='#owner-customers-section'?'customers':link.getAttribute('href')==='#owner-reports-section'?'reports':link.getAttribute('href')==='#owner-payments-section'?'payments':'overview');e.preventDefault();showWorkspaceScreen(screen);});
  $('history-toggle').addEventListener('click',async()=>{const box=$('history-content');const opening=box.classList.contains('hidden');box.classList.toggle('hidden');$('history-toggle').textContent=opening?'Close receipt history':'My receipt history';$('history-toggle').setAttribute('aria-expanded',String(opening));if(opening)await loadReceiptHistory();});
  $('history-search-btn').addEventListener('click',loadReceiptHistory);
  $('history-list').addEventListener('click',e=>{const b=e.target.closest('[data-view-pdf]');if(b)openReceiptPdf(b.dataset.viewPdf);});
  $('history-search').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();loadReceiptHistory();}});
  $('dashboard-edit-profile').addEventListener('click',()=>showWorkspaceScreen('profile'));
  $('profile-close')?.addEventListener('click',()=>{if(!goBackWorkspace())showWorkspaceScreen('dashboard',{fromBack:true});});
  $('business-logo').addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;const img=$('logo-preview');img.classList.remove('hidden');img.alt='Preparing selected business logo…';$('profile-error').textContent='Preparing logo…';try{state.profileLogoData=await compressLogo(file);img.src=state.profileLogoData;img.alt='Selected business logo preview';$('profile-error').textContent='Logo preview ready. Tap Save business profile to keep it.';}catch(err){state.profileLogoData=undefined;e.target.value='';img.removeAttribute('src');img.classList.add('hidden');$('profile-error').textContent=err.message;}});
  $('profile-form').addEventListener('submit',async e=>{e.preventDefault();const btn=$('profile-form').querySelector('button[type="submit"]');btn.disabled=true;btn.textContent='Saving…';$('profile-error').textContent='';const payload={businessName:$('profile-business-name').value.trim(),businessPhone:$('profile-business-phone').value.trim(),businessEmail:$('profile-business-email').value.trim()||null,legalName:$('profile-legal-name').value.trim()||null,storeName:$('profile-store-name').value.trim(),storeLocation:$('profile-store-location').value.trim(),houseName:$('profile-house-name').value.trim()||null,floor:$('profile-floor').value.trim()||null,houseNumber:$('profile-house-number').value.trim()||null,websiteUrl:$('profile-website').value.trim()||null,kraPin:$('profile-kra-pin').value.trim()||null,registrationCode:$('profile-registration-code').value.trim()||null,outletId:$('profile-outlet-id').value.trim()||null,terminalNumber:$('profile-terminal-number').value.trim()||null,receiptHeader:$('profile-receipt-header').value.trim()||null,receiptFooter:$('profile-receipt-footer').value.trim()||null};if(state.profileLogoData!==undefined)payload.logoData=state.profileLogoData;if(state.shopInsidePhotoDraft!==undefined)payload.shopInsidePhotoData=state.shopInsidePhotoDraft;if(state.shopOutsidePhotoDraft!==undefined)payload.shopOutsidePhotoData=state.shopOutsidePhotoDraft;try{await request('/api/v1/business/profile',{method:'PATCH',body:JSON.stringify(payload)});state.businessProfile={...state.businessProfile,...payload};renderDashboardBusinessProfile();renderAccountProfile();$('profile-error').textContent='Profile saved successfully. Your business details, logo and shop photos are updated.';$('profile-error').style.color='#16804a';}catch(err){$('profile-error').textContent=err.message||'Could not save business profile.';}finally{btn.disabled=false;btn.textContent='Save business profile';}});
  state.shopInsidePhotoDraft=undefined;state.shopOutsidePhotoDraft=undefined;
  async function prepareShopPhoto(inputId,previewId,key){
    $(inputId)?.addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;const preview=$(previewId);try{const photo=await compressLogo(file);state[key]=photo;preview.src=photo;preview.classList.remove('hidden');}catch(err){state[key]=undefined;e.target.value='';preview.removeAttribute('src');preview.classList.add('hidden');$('profile-error').textContent=err.message||'Could not prepare shop photo.';}});
  }
  prepareShopPhoto('profile-shop-inside','profile-shop-inside-preview','shopInsidePhotoDraft');
  prepareShopPhoto('profile-shop-outside','profile-shop-outside-preview','shopOutsidePhotoDraft');
  $('logout-btn').addEventListener('click',()=>{clearSession();window.dispatchEvent(new Event('swass:logout'));state.cart.clear();renderCart();$('profile-panel').classList.add('hidden');showLogin();});
  function returnToAuroraLogin(){if(!state.token){showLogin();return;}if(!window.confirm('Return to the AURORA login screen? You will be signed out.'))return;clearSession();window.dispatchEvent(new Event('swass:logout'));state.cart.clear();renderCart();$('profile-panel')?.classList.add('hidden');showLogin();}
  $('back-to-login-btn')?.addEventListener('click',returnToAuroraLogin);
  $('dashboard-back-to-login')?.addEventListener('click',returnToAuroraLogin);
  // No saved shop products are available in the receipt workflow.
  $('cart-list').addEventListener('click',e=>{const scan=e.target.closest('[data-scan-serial]');if(scan){imeiScannerTarget=scan.dataset.scanSerial;window.auroraSerialIndex=0;openImeiScanner(scan.dataset.scanSerial);}});
  $('cart-list').addEventListener('input',e=>{const price=e.target.closest('[data-price]');if(price){const row=state.cart.get(price.dataset.price);const value=Number(price.value);if(!row||!Number.isSafeInteger(value)||value<1||value>100000000000){$('checkout-open').disabled=true;return;}if(row&&Number.isSafeInteger(value)&&value>=1&&value<=100000000000){row.unitPriceKes=value;const line=price.closest('.cart-row')?.querySelector('.cart-line-total');if(line)line.textContent='Line subtotal: '+money(value*row.qty);const t=totals();$('subtotal').textContent=money(t.subtotal);$('total').textContent=money(t.total);$('checkout-open').disabled=!state.cart.size||t.total<0||[...$('cart-list').querySelectorAll('[data-price]')].some(input=>!Number.isSafeInteger(Number(input.value))||Number(input.value)<1||Number(input.value)>100000000000);}return;}const field=e.target.closest('[data-serial-index]');if(field){const row=state.cart.get(field.dataset.serialIndex);if(row){row.serials=Array.isArray(row.serials)?row.serials:['','',''];row.serials[Number(field.dataset.index)||0]=field.value;row.imei=row.serials[0]||'';}}});
  let productSearchTimer;
  // Sales are manual-entry only. No product catalogue is loaded or searched.
  $('discount').addEventListener('input',renderCart);$('clear-cart').addEventListener('click',()=>{state.cart.clear();$('discount').value='0';renderCart();});
  $('checkout-continue-payment')?.addEventListener('click',()=>{const fields=[$('buyer-name'),$('buyer-phone'),$('buyer-id')];const invalid=fields.find(field=>field&&!field.checkValidity());if(invalid){invalid.reportValidity();return;}$('checkout-customer-step')?.classList.add('hidden');$('checkout-payment-step')?.classList.remove('hidden');$('checkout-error').textContent='';});
  $('checkout-back-customer')?.addEventListener('click',()=>{$('checkout-payment-step')?.classList.add('hidden');$('checkout-customer-step')?.classList.remove('hidden');});
  $('checkout-open').addEventListener('click',openCheckout);$('checkout-close').addEventListener('click',()=>$('checkout-modal').classList.add('hidden'));$('checkout-form').addEventListener('submit',completeSale);
  $('payment-method')?.addEventListener('change',()=>{$('receipt-mpesa-fields')?.classList.toggle('hidden',$('payment-method').value!=='mpesa');if($('payment-method').value==='mpesa'&&!$('receipt-mpesa-phone').value)$('receipt-mpesa-phone').value=$('buyer-phone').value.trim();});
  $('buyer-phone')?.addEventListener('input',()=>{if($('payment-method')?.value==='mpesa'&&!$('receipt-mpesa-phone')?.dataset.edited)$('receipt-mpesa-phone').value=$('buyer-phone').value.trim();});
  $('receipt-mpesa-phone')?.addEventListener('input',e=>{e.currentTarget.dataset.edited='true';});
  $('receipt-close').addEventListener('click',()=>$('receipt-modal').classList.add('hidden'));$('new-sale').addEventListener('click',()=>$('receipt-modal').classList.add('hidden'));$('print-receipt').addEventListener('click',()=>{if(state.lastReceipt?.id)openReceiptPdf(state.lastReceipt.id);else window.print();});
  const shareBtn=$('share-receipt'); if(shareBtn) shareBtn.addEventListener('click', async()=>{ if(!state.lastReceipt)return; const verifyUrl=new URL('verify.html',window.location.href).href+'?token='+encodeURIComponent(state.lastReceipt.qrToken); const text=`AURORA E-RECEIPT ${state.lastReceipt.receiptNo} · KSh ${Number(state.lastReceipt.totalKes).toLocaleString('en-KE')} · Verify: ${verifyUrl}`; try { if(navigator.share) await navigator.share({title:'AURORA E-RECEIPT',text}); else if(navigator.clipboard) { await navigator.clipboard.writeText(text); alert('Receipt summary copied.'); } } catch {} });
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
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(error => console.warn('[AURORA] App installation support unavailable:', error?.message || 'registration failed')));
  }
  // Keep the signed-in session across refreshes; expire it after 3 idle hours.
  ['pointerdown','keydown','touchstart','click','scroll'].forEach(type=>window.addEventListener(type,touchSession,{passive:true}));
  window.addEventListener('focus',checkSessionExpiry);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')checkSessionExpiry();});
  window.setInterval(checkSessionExpiry,30000);
  // API URL is configurable without rebuilding: set the existing API URL in frontend/config.js before app.js.
  if(!API){ showNotice('API address is not configured yet. Check the existing API URL in frontend/config.js.',true); }

  // AURORA public shop directory: only shop owners may publish listings;
  // all signed-in platform account types may search and contact a listed shop.
  $('shop-search-toggle')?.addEventListener('click',()=>{
    const panel=$('shop-product-search-form');
    const opening=panel?.classList.contains('hidden');
    panel?.classList.toggle('hidden',!opening);
    if(opening)$('shop-product-search')?.focus();
  });
  $('shop-add-products')?.addEventListener('submit',async e=>{
    e.preventDefault();
    if(state.role!=='owner'){ $('shop-product-message').textContent='Only the shop owner can add public products.';return; }
    const btn=$('shop-product-submit'),message=$('shop-product-message');
    const payload={
      name:$('shop-product-name').value.trim(),
      priceKes:Number($('shop-product-price').value),
      stockQty:Number($('shop-product-quantity').value)
    };
    if(!payload.name||!Number.isSafeInteger(payload.priceKes)||payload.priceKes<1||!Number.isSafeInteger(payload.stockQty)||payload.stockQty<1){
      message.textContent='Enter the product name, a valid price and available quantity.';return;
    }
    btn.disabled=true;btn.textContent='Adding product…';message.textContent='';
    try{
      const result=await request('/api/v1/products/directory',{method:'POST',body:JSON.stringify(payload)});
      $('shop-add-products').reset();$('shop-product-quantity').value='1';
      message.textContent=(result.product?.name||payload.name)+' has been listed for customers across AURORA.';
      message.style.color='#176b52';
    }catch(err){message.textContent=err.message||'Could not add this product.';message.style.color='#a12b22';}
    finally{btn.disabled=false;btn.textContent='＋ Add Products';}
  });

  // Second-hand product seller declaration workspace.
  const secondhandPadState = { 'sh-signature': false, 'sh-thumbprint': false };
  function setupSecondhandPad(id) {
    const canvas = $(id); if (!canvas || canvas.dataset.ready === '1') return;
    canvas.dataset.ready = '1';
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#172b45';
    let drawing = false;
    const point = ev => { const r=canvas.getBoundingClientRect(); return {x:(ev.clientX-r.left)*canvas.width/r.width,y:(ev.clientY-r.top)*canvas.height/r.height}; };
    canvas.addEventListener('pointerdown',ev=>{ev.preventDefault();drawing=true;canvas.setPointerCapture?.(ev.pointerId);const p=point(ev);ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(p.x+.1,p.y+.1);ctx.stroke();secondhandPadState[id]=true;});
    canvas.addEventListener('pointermove',ev=>{if(!drawing)return;ev.preventDefault();const p=point(ev);ctx.lineTo(p.x,p.y);ctx.stroke();});
    const stop=()=>{drawing=false;};canvas.addEventListener('pointerup',stop);canvas.addEventListener('pointercancel',stop);canvas.addEventListener('lostpointercapture',stop);
  }
  function clearSecondhandPad(id) {
    const canvas=$(id);if(!canvas)return;canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);secondhandPadState[id]=false;
  }
  setupSecondhandPad('sh-signature');setupSecondhandPad('sh-thumbprint');
  document.querySelectorAll('[data-clear-pad]').forEach(btn=>btn.addEventListener('click',()=>clearSecondhandPad(btn.dataset.clearPad)));
  function watchSecondhandPhoto(inputId,previewId) {
    const input=$(inputId),preview=$(previewId);if(!input||!preview)return;
    input.addEventListener('change',()=>{const file=input.files?.[0];if(!file){preview.classList.add('hidden');return;}preview.src=URL.createObjectURL(file);preview.classList.remove('hidden');});
  }
  watchSecondhandPhoto('sh-id-photo','sh-id-preview');watchSecondhandPhoto('sh-seller-photo','sh-seller-preview');watchSecondhandPhoto('sh-phone-photo','sh-phone-preview');watchSecondhandPhoto('sh-receipt-photo','sh-receipt-preview');
  function syncSecondhandReceiptMode(){const selected=document.querySelector('input[name="sh-receipt-choice"]:checked')?.value||'without_receipt';$('sh-sale-type').value=selected;const withReceipt=selected==='with_receipt';$('sh-no-receipt-wrap')?.classList.toggle('hidden',withReceipt);$('sh-receipt-photo-wrap')?.classList.toggle('hidden',!withReceipt);$('sh-no-receipt').required=!withReceipt;$('sh-receipt-photo').required=withReceipt;$('sh-thumbprint-wrap')?.classList.toggle('hidden',withReceipt);$('sh-declaration-with-receipt')?.classList.toggle('hidden',!withReceipt);$('sh-declaration-without-receipt')?.classList.toggle('hidden',withReceipt);document.querySelectorAll('.secondhand-receipt-option').forEach(el=>el.classList.toggle('selected',el.querySelector('input')?.checked));}
  document.querySelectorAll('input[name="sh-receipt-choice"]').forEach(el=>el.addEventListener('change',syncSecondhandReceiptMode));syncSecondhandReceiptMode();
  async function secondhandImageData(inputId,required=false) {
    const file=$(inputId)?.files?.[0];if(!file){if(required)throw new Error('Please attach the required seller ID and product photos.');return null;}
    if(!file.type.startsWith('image/'))throw new Error('Choose an image file for '+inputId.replace('sh-','').replaceAll('-',' ')+'.');
    return await new Promise((resolve,reject)=>{
      const reader=new FileReader();reader.onerror=()=>reject(new Error('Could not read an uploaded photo.'));
      reader.onload=()=>{const img=new Image();img.onerror=()=>reject(new Error('This photo format is not supported. Please use JPG or PNG.'));
        img.onload=()=>{const scale=Math.min(1,700/Math.max(img.width,img.height));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);let data=canvas.toDataURL('image/jpeg',.46);for(let attempt=0;data.length>45000&&attempt<3;attempt++){const factor=attempt===0?.72:.78;canvas.width=Math.max(1,Math.round(canvas.width*factor));canvas.height=Math.max(1,Math.round(canvas.height*factor));ctx.drawImage(img,0,0,canvas.width,canvas.height);data=canvas.toDataURL('image/jpeg',attempt===0?.34:.28);}if(data.length>50000)reject(new Error('Photo is too large. Please take a closer photo with less background.'));else resolve(data);};
        img.src=String(reader.result||'');};reader.readAsDataURL(file);
    });
  }
  async function checkSecondhandBiometricSupport() {
    const status=$('sh-biometric-status');if(!status)return;
    try{
      const supported=!!(window.PublicKeyCredential&&window.isSecureContext&&await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
      status.textContent=supported?'This device reports a built-in secure authenticator (it may use fingerprint, face recognition or device PIN). This check does not capture or identify a fingerprint.':'No built-in platform biometric authenticator was detected. Continue with the seller signature and finger-drawn thumbprint mark.';
      status.classList.toggle('available',supported);
    }catch{status.textContent='Device biometric availability could not be checked. Use the signature and finger-drawn thumbprint mark.';}
  }
  checkSecondhandBiometricSupport();
  $('secondhand-open-card')?.addEventListener('click',()=>{
    if(state.role!=='owner'){showNotice('Only the shop owner can record second-hand product purchases.',true);return;}
    $('shop-directory-card')?.classList.add('hidden');
    document.querySelector('#shop-home > .shop-directory-card')?.classList.add('hidden');
    $('shop-product-results')?.classList.add('hidden');
    $('secondhand-open-card')?.classList.add('hidden');
    $('secondhand-panel')?.classList.remove('hidden');
    checkSecondhandBiometricSupport();
  });
  $('secondhand-back')?.addEventListener('click',()=>{
    $('secondhand-panel')?.classList.add('hidden');
    document.querySelector('#shop-home > .shop-directory-card')?.classList.remove('hidden');
    $('secondhand-open-card')?.classList.remove('hidden');
    $('secondhand-history')?.classList.add('hidden');
    $('secondhand-saved-record')?.classList.add('hidden');
  });
  function renderSecondhandRecord(d) {
    const target=$('secondhand-saved-record');if(!target)return;
    const safe=v=>escapeHtml(v??'—');
    const date=d.createdAt?new Date(d.createdAt).toLocaleString():'Recorded by AURORA';
    target.innerHTML=`<div class="secondhand-record-print"><div class="secondhand-record-head"><div><p class="eyebrow">AURORA · SHOP RECORD</p><h2>SECOND-HAND RECEIPT</h2><p>Declaration reference: <strong>${safe(d.declarationRef)}</strong></p></div><span class="secondhand-record-stamp">DECLARED</span></div>
      <p><strong>Recorded:</strong> ${safe(date)}</p><h3>Seller identification</h3><p><strong>Name:</strong> ${safe(d.sellerName)} · <strong>National ID:</strong> ${safe(d.nationalId)}</p><p><strong>Phone:</strong> ${safe(d.sellerPhone)} · <strong>Alternative:</strong> ${safe(d.alternativePhone)}</p><p><strong>Address:</strong> ${safe(d.residentialAddress)}</p>
      <h3>Product details</h3><p><strong>Receipt status:</strong> ${safe(d.saleType==='with_receipt'?'Original receipt provided':'No original receipt — seller declaration')} </p><p><strong>Product name:</strong> ${safe(d.productName||d.phoneMakeModel)} · <strong>Condition:</strong> ${safe(d.condition)}</p><p><strong>Product identifier / IMEI:</strong> ${safe(d.imei1||'Not provided')} · <strong>Second identifier:</strong> ${safe(d.imei2)} · <strong>Serial:</strong> ${safe(d.serialNumber)}</p><p><strong>Purchase price:</strong> KSh ${safe(Number(d.purchasePriceKes).toLocaleString())}</p>${d.saleType==='with_receipt'?'':`<p><strong>Reason receipt unavailable:</strong> ${safe(d.noReceiptReason)}</p>`}
      <h3>Seller's declaration</h3><p>I declare that I am the lawful owner of this product or have full legal authority to sell it; that, to the best of my knowledge, it is not stolen, unlawfully obtained, fraudulently acquired or subject to an ownership dispute; and that the product identifiers and serial details I have supplied are true and have not knowingly been altered. I have disclosed the receipt status recorded above. I accept responsibility for false statements, fraudulent representation or an unlawful ownership claim connected with this sale, and I agree to cooperate with lawful investigations and provide further information when lawfully required.</p>
      <p class="secondhand-receipt-notice"><strong>SELLER LIABILITY NOTICE:</strong> I confirm that I am the lawful owner of the product recorded above or legally authorised to sell it. If the product is found to be stolen, fraudulently obtained, unlawfully possessed, or subject to a false ownership claim, I accept responsibility for any false information or unlawful sale attributable to me and agree to cooperate with lawful investigations. I understand that I may be held liable under applicable Kenyan law.</p>
      <div class="secondhand-record-images">${d.idPhotoData?`<figure><img src="${d.idPhotoData}" alt="Seller ID"><figcaption>Seller ID</figcaption></figure>`:''}${d.sellerPhotoData?`<figure><img src="${d.sellerPhotoData}" alt="Seller photo"><figcaption>Seller photo</figcaption></figure>`:''}${d.phonePhotoData?`<figure><img src="${d.phonePhotoData}" alt="Phone photo"><figcaption>Product and identifying details</figcaption></figure>`:''}${d.receiptPhotoData?`<figure><img src="${d.receiptPhotoData}" alt="Original purchase receipt"><figcaption>Original purchase receipt</figcaption></figure>`:''}</div>
      <div class="secondhand-record-signatures"><figure><strong>Seller signature</strong><img src="${d.signatureData}" alt="Seller signature"></figure>${d.thumbprintData?`<figure><strong>Seller thumbprint mark (drawn)</strong><img src="${d.thumbprintData}" alt="Drawn thumbprint mark"></figure>`:''}</div>
      <p><strong>Witness:</strong> ${safe(d.witnessName)} · ${safe(d.witnessPhone)}</p><p><strong>Shop representative:</strong> ${safe(d.shopRepresentativeName||'Recorded shop owner')} · Seller and product checks acknowledged</p><p class="tiny">The seller confirmed the declaration electronically. This record supports shop record-keeping; it does not itself determine legal ownership or guarantee a court outcome.</p></div><button id="secondhand-print-button" class="btn btn-primary full" type="button">Print / Save as PDF</button><button id="secondhand-amend-button" class="btn btn-light full" type="button" data-declaration-id="${safe(d.id)}">Amend saved declaration</button><button id="secondhand-amend-history-button" class="btn btn-light full" type="button" data-declaration-id="${safe(d.id)}">View amendment history</button><p id="secondhand-amend-message" class="muted" aria-live="polite"></p>`;
    if(d.pdfBase64){
      const download=document.createElement('a');download.className='btn btn-primary full secondhand-download-pdf';
      download.href='data:application/pdf;base64,'+d.pdfBase64;download.download='AURORA-Second-Hand-'+(d.declarationRef||'receipt')+'.pdf';
      download.textContent='Download issued PDF';target.insertBefore(download,target.firstChild);
    }
    const buyerSummary=document.createElement('p');buyerSummary.className='secondhand-buyer-summary';
    buyerSummary.textContent='Buyer: '+(d.buyerName||'')+' · ID: '+(d.buyerNationalId||'')+' · Phone: '+(d.buyerPhone||'')+' · Email: '+(d.buyerEmail||'');
    target.insertBefore(buyerSummary,target.firstChild);
    target.classList.remove('hidden');
    $('secondhand-print-button')?.addEventListener('click',()=>window.print());
    $('secondhand-amend-button')?.addEventListener('click',async()=>{
      const id=d.id;if(!id){showNotice('This saved record cannot be amended until it is reopened from history.',true);return;}
      const reason=window.prompt('Why is this Special Receipt being amended?');if(!reason||!reason.trim())return;
      const productName=window.prompt('Correct product name / model:',d.productName||d.phoneMakeModel||'');if(productName===null)return;
      const imei1=window.prompt('Correct IMEI / product identifier:',d.imei1||'');if(imei1===null)return;
      const priceText=window.prompt('Correct purchase price in KSh:',String(d.purchasePriceKes||''));if(priceText===null)return;
      const price=Number(priceText);if(!Number.isSafeInteger(price)||price<1){showNotice('Enter a valid whole-number purchase price.',true);return;}
      const button=$('secondhand-amend-button');button.disabled=true;button.textContent='Saving new version…';
      try{
        const result=await request('/api/v1/second-hand-phone-declarations/'+encodeURIComponent(id)+'/amendments',{method:'POST',body:JSON.stringify({reason:reason.trim(),changes:{productName:productName.trim(),imei1:imei1.trim(),purchasePriceKes:price}})});
        $('secondhand-amend-message').textContent='Amendment saved as version '+result.amendment.versionNo+'. The original declaration remains unchanged.';
      }catch(err){$('secondhand-amend-message').textContent=err.message||'Could not save amendment.';}
      finally{button.disabled=false;button.textContent='Amend saved declaration';}
    });
    $('secondhand-amend-history-button')?.addEventListener('click',async()=>{
      const id=d.id;if(!id)return;const out=$('secondhand-amend-message');out.textContent='Loading amendment history…';
      try{const result=await request('/api/v1/second-hand-phone-declarations/'+encodeURIComponent(id)+'/amendments');const rows=result.amendments||[];out.textContent=rows.length?rows.map(a=>'Version '+a.versionNo+' · '+new Date(a.createdAt).toLocaleString()+' · '+a.reason+' · '+JSON.stringify(a.changes)).join('\\n'):'No amendments recorded. Original version remains unchanged.';}
      catch(err){out.textContent=err.message||'Could not load amendment history.';}
    });
    target.scrollIntoView({behavior:'smooth',block:'start'});
  }
  $('secondhand-form')?.addEventListener('submit',async ev=>{
    ev.preventDefault();const message=$('secondhand-message'),button=$('secondhand-submit');
    const selectedSaleType=$('sh-sale-type').value;if(!secondhandPadState['sh-signature']||(selectedSaleType==='without_receipt'&&!secondhandPadState['sh-thumbprint'])){message.textContent=selectedSaleType==='without_receipt'?'The seller must complete both the signature and thumbprint mark on the screen.':'The seller must complete the electronic signature.';message.style.color='#a12b22';return;}
    if(!$('sh-declaration-accepted').checked){message.textContent='The seller must confirm the declaration before submission.';message.style.color='#a12b22';return;}
    if(!$('sh-shop-acknowledged').checked){message.textContent='The shop representative must confirm that the seller and product details were checked.';message.style.color='#a12b22';return;}
    const imei1=$('sh-imei1').value.trim(),imei2=$('sh-imei2').value.trim();
    button.disabled=true;button.textContent='Saving protected declaration…';message.textContent='Preparing evidence and saving the seller declaration…';message.style.color='';
    try{
      const saleType=$('sh-sale-type').value;const [idPhotoData,phonePhotoData,sellerPhotoData,receiptPhotoData]=await Promise.all([secondhandImageData('sh-id-photo',true),secondhandImageData('sh-phone-photo',true),secondhandImageData('sh-seller-photo',true),secondhandImageData('sh-receipt-photo',saleType==='with_receipt')]);
      const payload={saleType,receiptPhotoData,sellerName:$('sh-seller-name').value.trim(),nationalId:$('sh-national-id').value.trim(),sellerPhone:$('sh-seller-phone').value.trim(),sellerEmail:$('sh-seller-email').value.trim(),buyerName:$('sh-buyer-name').value.trim(),buyerNationalId:$('sh-buyer-id').value.trim(),buyerPhone:$('sh-buyer-phone').value.trim(),buyerEmail:$('sh-buyer-email').value.trim(),alternativePhone:$('sh-alt-phone').value.trim(),residentialAddress:$('sh-address').value.trim(),productName:$('sh-model').value.trim(),imei1,imei2,serialNumber:$('sh-serial').value.trim(),condition:$('sh-condition').value,purchasePriceKes:Number($('sh-price').value),noReceiptReason:saleType==='with_receipt'?'Original purchase receipt photographed and attached.':$('sh-no-receipt').value.trim(),sellerPhotoData,idPhotoData,phonePhotoData,signatureData:$('sh-signature').toDataURL('image/png'),thumbprintData:saleType==='without_receipt'?$('sh-thumbprint').toDataURL('image/png'):null,witnessName:$('sh-witness-name').value.trim(),witnessPhone:$('sh-witness-phone').value.trim(),declarationAccepted:true,shopAcknowledged:$('sh-shop-acknowledged').checked};
      const result=await request('/api/v1/second-hand-phone-declarations',{method:'POST',body:JSON.stringify(payload)});
      const delivery=result.delivery||{};const status=(party,channel)=>delivery[party]?.[channel]?.sent?'Sent':'Not sent'+(delivery[party]?.[channel]?.reason?': '+delivery[party][channel].reason:'');
      message.textContent='Second-Hand Receipt PDF created · '+(result.declaration?.declarationRef||'saved')+'. Seller — email: '+status('seller','email')+', WhatsApp: '+status('seller','whatsapp')+'. Buyer — email: '+status('buyer','email')+', WhatsApp: '+status('buyer','whatsapp')+'. Download the PDF below if any delivery failed.';
      message.style.color=(delivery.seller?.email?.sent&&delivery.seller?.whatsapp?.sent&&delivery.buyer?.email?.sent&&delivery.buyer?.whatsapp?.sent)?'#176b52':'#9a5b00';
      renderSecondhandRecord({...result.declaration,pdfBase64:result.pdfBase64});
      $('secondhand-form').reset();syncSecondhandReceiptMode();['sh-signature','sh-thumbprint'].forEach(clearSecondhandPad);
      ['sh-id-preview','sh-seller-preview','sh-phone-preview','sh-receipt-preview'].forEach(id=>$(id)?.classList.add('hidden'));
      $('secondhand-history')?.classList.add('hidden');
    }catch(err){message.textContent=err.message||'Could not save the declaration. Please check the details and try again.';message.style.color='#a12b22';}
    finally{button.disabled=false;button.textContent='Save Seller Declaration & Record Product';}
  });
  $('secondhand-clear')?.addEventListener('click',()=>{
    const form=$('secondhand-form');if(!form)return;
    form.reset();
    syncSecondhandReceiptMode();
    ['sh-signature','sh-thumbprint'].forEach(clearSecondhandPad);
    ['sh-id-preview','sh-seller-preview','sh-phone-preview','sh-receipt-preview'].forEach(id=>{
      const preview=$(id);if(preview){if(preview.src&&preview.src.startsWith('blob:'))URL.revokeObjectURL(preview.src);preview.removeAttribute('src');preview.classList.add('hidden');}
    });
    $('secondhand-message').textContent='';
    $('secondhand-message').style.color='';
    $('secondhand-saved-record').innerHTML='';
    $('secondhand-saved-record').classList.add('hidden');
    $('secondhand-history').classList.add('hidden');
    $('secondhand-history').innerHTML='';
    $('secondhand-form').scrollIntoView({behavior:'smooth',block:'start'});
  });
  $('secondhand-history-toggle')?.addEventListener('click',async()=>{
    const panel=$('secondhand-history');if(!panel)return;
    if(!panel.classList.contains('hidden')){panel.classList.add('hidden');return;}
    panel.classList.remove('hidden');panel.innerHTML='<p class="muted">Loading saved declarations…</p>';
    try{
      const data=await request('/api/v1/second-hand-phone-declarations');
      const rows=data.declarations||[];
      if(!rows.length){panel.innerHTML='<p class="muted">No second-hand product declarations have been saved for this shop yet.</p>';return;}
      panel.innerHTML='<h3>Saved Second-Hand Receipts</h3>'+rows.map(d=>`<button type="button" class="secondhand-history-row" data-declaration-id="${escapeHtml(d.id)}"><strong>${escapeHtml(d.sellerName)} → ${escapeHtml(d.buyerName||'Buyer')}</strong><span>${escapeHtml(d.phoneMakeModel)} · Buyer phone: ${escapeHtml(d.buyerPhone||'—')}</span><small>${escapeHtml(d.declarationRef)} · ${escapeHtml(d.createdAt?new Date(d.createdAt).toLocaleString():'')}</small></button>`).join('');
    }catch(err){panel.innerHTML='<p class="error">'+escapeHtml(err.message||'Could not load declarations.')+'</p>';}
  });
  $('secondhand-history')?.addEventListener('click',async ev=>{
    const btn=ev.target.closest('[data-declaration-id]');if(!btn)return;
    btn.disabled=true;btn.textContent='Loading signed record…';
    try{const result=await request('/api/v1/second-hand-phone-declarations/'+encodeURIComponent(btn.dataset.declarationId));renderSecondhandRecord(result.declaration);}
    catch(err){btn.disabled=false;btn.textContent=err.message||'Could not open this record.';}
  });

  $('shop-product-search-form')?.addEventListener('submit',async e=>{
    e.preventDefault();
    const query=$('shop-product-search').value.trim(),results=$('shop-product-results');
    if(query.length<2){results.classList.remove('hidden');results.innerHTML='<p class="empty">Enter at least two letters to search for a product.</p>';return;}
    results.classList.remove('hidden');results.innerHTML='<p class="empty">Searching shops…</p>';
    try{
      const data=await request('/api/v1/products/directory/search?q='+encodeURIComponent(query));
      const products=data.products||[];
      if(!products.length){results.innerHTML='<p class="empty">No shop has listed “'+escapeHtml(query)+'” yet. Try another product name.</p>';return;}
      results.innerHTML='<h2>Shops with this product</h2>'+products.map(p=>{
        const phone=String(p.shopPhone||'').trim();
        const tel=phone.replace(/[^0-9+]/g,'');
        return '<article class="shop-product-result-card"><div class="shop-product-result-top"><strong>'+escapeHtml(p.name)+'</strong><b>'+money(p.priceKes)+'</b></div>'+
          '<p class="shop-result-business">'+escapeHtml(p.businessName||'Registered shop')+(p.storeName?' · '+escapeHtml(p.storeName):'')+'</p>'+
          (p.storeLocation?'<p class="shop-result-location">'+escapeHtml(p.storeLocation)+'</p>':'')+
          '<div class="shop-result-contact"><span>Shop number: <strong>'+escapeHtml(phone||'Not registered')+'</strong></span>'+
          (tel?'<a class="shop-enquiry-link" href="tel:'+escapeHtml(tel)+'">Enquire</a>':'')+'</div></article>';
      }).join('');
    }catch(err){results.innerHTML='<p class="empty">'+escapeHtml(err.message||'Product search failed. Please try again.')+'</p>';}
  });

  renderCart();void restoreSession();
})();
