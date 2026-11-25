(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const API = (window.SWASS_API_URL || '').replace(/\/$/, '') + '/api/v1';
  const sessionKey = 'swass-auth-session-v1';
  const browser = window.SimpleWebAuthnBrowser;

  function session() {
    try { return JSON.parse(localStorage.getItem(sessionKey) || 'null'); } catch { return null; }
  }
  function authHeaders(token) {
    return { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) };
  }
  async function call(path, method = 'GET', body, token = session()?.token || '') {
    const response = await fetch(API + path, {
      method, headers: authHeaders(token),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(75000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'Passkey request failed.');
    return data;
  }
  function deviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/Android/i.test(ua)) return 'Android phone';
    return 'This device';
  }
  async function supported() {
    try {
      return !!(window.isSecureContext && window.PublicKeyCredential &&
        await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable() && browser);
    } catch { return false; }
  }
  async function register() {
    const button = $('passkey-enable-btn'), message = $('passkey-settings-message');
    const token = session()?.token;
    if (!token) throw new Error('Please sign in again before registering this device.');
    button.disabled = true; message.textContent = 'Preparing secure device registration…';
    try {
      const options = await call('/passkeys/register/options', 'POST', {}, token);
      const credential = await browser.startRegistration({ optionsJSON: options });
      await call('/passkeys/register/verify', 'POST', { credential, deviceName: deviceName() }, token);
      message.textContent = 'This device is now registered. You can use its fingerprint or screen lock to sign in.';
      await refreshDevices();
    } finally { button.disabled = false; }
  }
  async function refreshDevices() {
    const list = $('passkey-device-list'), message = $('passkey-settings-message');
    if (!list) return;
    const token = session()?.token;
    if (!token) { list.replaceChildren(); return; }
    try {
      const data = await call('/passkeys/list', 'GET', undefined, token);
      list.replaceChildren();
      (data.items || []).forEach(item => {
        const li = document.createElement('li');
        const details = document.createElement('span');
        const title = document.createElement('strong'); title.textContent = item.device_name || 'Registered device';
        const date = document.createElement('small'); date.textContent = 'Added ' + new Date(item.created_at).toLocaleDateString('en-GB') + (item.last_used_at ? ' · Last used ' + new Date(item.last_used_at).toLocaleDateString('en-GB') : '');
        details.append(title, date);
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove';
        remove.addEventListener('click', async () => {
          remove.disabled = true;
          try { await call('/passkeys/' + encodeURIComponent(item.id), 'DELETE', undefined, token); message.textContent = 'Device passkey removed.'; await refreshDevices(); }
          catch (error) { message.textContent = error.message; remove.disabled = false; }
        });
        li.append(details, remove); list.append(li);
      });
      if (!list.children.length) { const li = document.createElement('li'); li.textContent = 'No devices registered yet.'; list.append(li); }
    } catch (error) { if (message) message.textContent = error.message; }
  }
  async function login() {
    const button = $('passkey-login-btn'), message = $('passkey-login-message');
    button.disabled = true; message.textContent = 'Waiting for your phone to verify…';
    try {
      const { options, flowId } = await call('/passkeys/login/options', 'POST', {});
      const credential = await browser.startAuthentication({ optionsJSON: options });
      const result = await call('/passkeys/login/verify', 'POST', { flowId, credential });
      const claims = JSON.parse(atob(result.accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (claims.role === 'super_admin') {
        sessionStorage.setItem('aurora-admin-token', result.accessToken);
        location.href = '/admin.html';
        return;
      }
      localStorage.setItem(sessionKey, JSON.stringify({
        token: result.accessToken, role: claims.role, userName: result.user?.fullName || '',
        staffTitle: '', userPhotoData: '', userPhone: result.user?.phone || '',
        userEmail: result.user?.email || '', lastActivity: Date.now(),
      }));
      location.href = '/';
    } catch (error) {
      message.textContent = error.name === 'NotAllowedError' ? 'Passkey sign-in was cancelled. You can still use your password.' : (error.message || 'Passkey sign-in failed. Use your password.');
    } finally { button.disabled = false; }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const loginButton = $('passkey-login-btn');
    if (loginButton) {
      if (await supported()) {
        loginButton.classList.remove('hidden');
        loginButton.addEventListener('click', login);
      }
    }
    const settings = $('passkey-settings');
    if (settings) {
      if (await supported()) {
        settings.classList.remove('hidden');
        $('passkey-support-state').textContent = 'Device supported';
        $('passkey-support-state').classList.add('ready');
        $('passkey-enable-btn').disabled = false;
        $('passkey-enable-btn').addEventListener('click', async () => {
          try { await register(); } catch (error) { $('passkey-settings-message').textContent = error.name === 'NotAllowedError' ? 'Setup cancelled. No passkey was added.' : error.message; }
        });
        $('passkey-refresh-btn').addEventListener('click', refreshDevices);
        $('profile-menu-btn')?.addEventListener('click', () => { void refreshDevices(); });
        window.addEventListener('swass:login', () => { void refreshDevices(); });
        void refreshDevices();
      } else {
        settings.classList.add('hidden');
      }
    }
  });
})();
