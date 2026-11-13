(() => {
  const message=document.getElementById('verify-message');
  const API=(window.SWASS_API_URL||'').replace(/\/$/,'');
  const token=new URLSearchParams(window.location.search).get('token');
  if(!token){message.textContent='This verification link is incomplete. Request a new verification email.';return;}
  const isAdminVerification=new URLSearchParams(window.location.search).get('type')==='admin';
  const endpoint=isAdminVerification
    ? '/api/v1/auth/admin/email-verification/verify'
    : '/api/v1/auth/email-verification/verify';
  fetch(API+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})})
    .then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.message||'Verification failed');return d;})
    .then(d=>{
      message.textContent=d.message||(isAdminVerification?'Administrator email verified. Returning to the Admin Portal…':'Your email address is verified.');
      if(isAdminVerification){
        const returnLink=document.querySelector('a.btn');
        if(returnLink){returnLink.href='./admin.html';returnLink.textContent='Continue to Admin Portal';}
        window.setTimeout(()=>window.location.replace('./admin.html?verified=1'),1200);
      }
    })
    .catch(e=>{message.textContent=e.message;});
})();