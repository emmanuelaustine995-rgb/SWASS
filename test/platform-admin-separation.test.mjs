import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../frontend/index.html');
const app = read('../frontend/app.js');
const css = read('../frontend/responsive-workspace.css');

test('ordinary login exposes only shop, staff, freelancer and customer choices', () => {
  const choices = [...html.matchAll(/data-login-role="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(choices, ['owner', 'staff', 'freelancer', 'customer']);
  assert.doesNotMatch(html, /class="[^"]*platform-admin-login-tab[^"]*"[^>]*data-login-role="platform_admin"/);
  // The hidden value is retained for the dedicated entry flow, not shown as an ordinary choice.
  assert.match(html, /<option value="platform_admin">Platform Admin<\/option>/);
});

test('Platform Admin login is available only through its separate URL mode', () => {
  assert.match(app, /get\('platform-admin'\)\s*===\s*'1'/);
  assert.match(app, /if\s*\(platformAdminLoginMode\)[\s\S]*?\$\('login-account-type'\)\.value\s*=\s*'platform_admin'/);
  assert.match(app, /accountType\s*===\s*'platform_admin'[\s\S]*?\/api\/v1\/auth\/admin\/login/);
  assert.match(app, /\/api\/v1\/auth\/login/);
  assert.match(app, /accountType==='platform_admin' && claims\.role!=='super_admin'/);
  assert.match(app, /accountType!=='platform_admin' && claims\.role==='super_admin'/);
  assert.match(app, /if\(platformAdminLoginMode\)\{clearSession\(\);showLogin\(\);\}/);
});

test('global platform controllers remain restricted to super_admin', () => {
  for (const path of [
    '../src/platform-admin/platform-admin.controller.ts',
    '../src/platform-admin/platform-operations.controller.ts',
    '../src/platform-admin/ai-maintenance.controller.ts',
    '../src/platform-admin/ai-repair.controller.ts',
    '../src/platform-finance/platform-finance.controller.ts',
  ]) {
    const source = read(path);
    assert.match(source, /@UseGuards\(AuthGuard, RolesGuard\)[\s\S]*?@Roles\('super_admin'\)[\s\S]*?export class/ , path);
  }
});


test('super-admin control room is separate from ordinary shop navigation and POS', () => {
  const dashboard = app.slice(app.indexOf('function showWorkspaceScreen('), app.indexOf("}else if(screen==='subscription')"));
  assert.match(dashboard, /document\.body\.classList\.toggle\('platform-admin-workspace',state\.role==='super_admin'\)/);
  assert.match(dashboard, /if\(state\.role==='super_admin'\)[\s\S]*?pos\?\.classList\.add\('hidden'\)/);
  assert.match(dashboard, /\$\('workspace-nav'\)\?\.classList\.add\('hidden'\)/);
  assert.doesNotMatch(dashboard, /pos\?\.classList\.remove\('hidden'\)/);
  assert.match(app, /document\.body\.classList\.remove\('platform-admin-workspace'\)/);
});

test('ordinary home never restores a saved Platform Admin session', () => {
  assert.match(app, /if\(saved\.role==='super_admin'\)\{\s*localStorage\.removeItem\(SESSION_KEY\);\s*showLogin\(\);\s*return;\s*\}/);
  assert.match(app, /function restoreSession\(\)[\s\S]*?if\(saved\.role==='super_admin'\)/);
});

test('super-admin cannot navigate into ordinary shop screens', () => {
  assert.match(app, /if\(state\.role==='super_admin'&&screen!=='dashboard'\)screen='dashboard'/);
  assert.match(css, /body\.platform-admin-workspace #workspace-nav/);
});


test('ordinary workspace uses the new AURORA design while login and Platform Admin remain available', () => {
  const modernCss = read('../frontend/aurora-modern.css');
  assert.match(modernCss, /--aurora-purple/);
  assert.match(modernCss, /\.bottom-nav/);
  assert.match(modernCss, /prefers-reduced-motion/);
  assert.doesNotMatch(read('../frontend/styles.css'), /ORDINARY WORKSPACE CLEAN-SLATE RESET/);
  assert.match(html, /aurora-modern\.css\?v=/);
  assert.match(app, /document\.body\.classList\.add\('workspace-active'\)/);
  assert.match(app, /document\.body\.classList\.toggle\('platform-admin-workspace',state\.role==='super_admin'\)/);
  assert.match(read('../frontend/admin.html'), /Admin Control Centre/);
  assert.match(html, /id="login-view"/);
  assert.match(html, /id="register-form"/);
});


test('fresh ordinary navigation and receipt pages have responsive design rules', () => {
  const modernCss = read('../frontend/aurora-modern.css');
  assert.match(modernCss, /body:not\(\.platform-admin-workspace\) #workspace-nav/);
  assert.match(modernCss, /\.receipt-actions-grid/);
  assert.match(modernCss, /#pos-view/);
  assert.match(modernCss, /\.subscription-choice-grid/);
  assert.match(modernCss, /\.receipt-history-panel/);
  assert.match(html, /id="workspace-nav"/);
});


test('all ordinary account recovery and support pages share the AURORA design system', () => {
  for (const page of [
    '../frontend/recover.html',
    '../frontend/verify.html',
    '../frontend/verify-email.html',
    '../frontend/recover-secondhand.html',
    '../frontend/staff-invite.html',
    '../frontend/about.html',
  ]) {
    const source = read(page);
    assert.match(source, /aurora-modern\.css\?v=20261120-brand-identity/, page);
  }
  const modernCss = read('../frontend/aurora-modern.css');
  assert.match(modernCss, /body\.registration-open:not\(\.platform-admin-workspace\)/);
  assert.match(modernCss, /--aurora-canvas/);
  assert.match(modernCss, /#register-form input:focus/);
  assert.match(read('../frontend/admin.html'), /Admin Control Centre/);
  assert.doesNotMatch(read('../frontend/admin.html'), /aurora-modern\.css/);
});


test('standalone recovery, verification, invitation and About pages have responsive AURORA layouts', () => {
  const modernCss = read('../frontend/aurora-modern.css');
  assert.match(modernCss, /main\.auth-shell/);
  assert.match(modernCss, /\.shell\[style\*="max-width:560px"\]/);
  assert.match(modernCss, /\.wrap main>\.hero/);
  assert.match(modernCss, /\.wrap \.content \.card/);
  for (const page of [
    '../frontend/recover.html',
    '../frontend/verify.html',
    '../frontend/verify-email.html',
    '../frontend/recover-secondhand.html',
    '../frontend/staff-invite.html',
    '../frontend/about.html',
  ]) {
    assert.match(read(page), /aurora-modern\.css\?v=20261120-brand-identity/, page);
  }
});

test('ordinary workspace HTML has no duplicate element IDs', () => {
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size, 'Duplicate IDs can break form and navigation handlers');
});


test('business naming flow distinguishes the public shop name from the account owner', () => {
  assert.match(html, /id="owner-signup-fields" class="signup-identity-step"/);
  assert.match(html, /Public shop \/ trading name/);
  assert.match(html, /id="reg-business"/);
  assert.match(html, /id="reg-name"/);
  assert.match(html, /signup-step-number/);
  assert.match(app, /businessName:customerSignupMode\?'':\$\('reg-business'\)\.value\.trim\(\)/);
});

test('shop branding has a dedicated logo artboard and separate customer-facing and branch names', () => {
  assert.match(html, /class="brand-identity-panel"/);
  assert.match(html, /class="logo-artboard"/);
  assert.match(html, /id="logo-preview"/);
  assert.match(html, /id="business-logo"/);
  assert.match(html, /id="profile-business-name"/);
  assert.match(html, /id="profile-store-name"/);
  assert.match(app, /state\.profileLogoData=await compressLogo\(file\)/);
  assert.match(app, /payload\.logoData=state\.profileLogoData/);
});

test('public and account support pages use distinct page compositions', () => {
  const pages = {
    '../frontend/about.html': /class="page-about"/,
    '../frontend/recover.html': /class="page-recover"/,
    '../frontend/verify.html': /class="page-verify"/,
    '../frontend/verify-email.html': /class="page-verify-email"/,
    '../frontend/recover-secondhand.html': /class="page-secondhand"/,
    '../frontend/staff-invite.html': /class="page-staff-invite"/,
  };
  for (const [path, marker] of Object.entries(pages)) assert.match(read(path), marker, path);
  const modernCss = read('../frontend/aurora-modern.css');
  assert.match(modernCss, /body\.page-about main/);
  assert.match(modernCss, /body\.page-recover/);
  assert.match(modernCss, /body\.page-verify-email/);
  assert.match(modernCss, /body\.page-staff-invite/);
  assert.doesNotMatch(read('../frontend/admin.html'), /aurora-modern\.css/);
});


test('platform finance and cybersecurity controls never render in the ordinary AURORA home page', () => {
  assert.doesNotMatch(html, /id="platform-referral-admin"/);
  assert.doesNotMatch(html, /Cybersecurity &amp; system maintenance/);
  assert.match(app, /if\(state\.role==='super_admin'\)[\s\S]*?sessionStorage\.setItem\('aurora-admin-token',state\.token\)[\s\S]*?window\.location\.replace\('\.\/admin\.html'\)/);
  const adminPage = read('../frontend/admin.html');
  assert.match(adminPage, /let token=sessionStorage\.getItem\('aurora-admin-token'\)\|\|''/);
  assert.match(adminPage, /api\('\/platform-admin\/overview'\)\.then\([\s\S]*?showApp\(\)/);
  assert.match(adminPage, /localStorage\.removeItem\('swass-auth-session-v1'\)/);
});


test('AURORA redesign changes real page markup and provides working dashboard shortcuts', () => {
  assert.match(html, /class="login-wrap aurora-login-layout"/);
  assert.match(html, /class="aurora-login-story"/);
  assert.match(html, /class="aurora-dashboard-hero"/);
  assert.match(html, /class="panel receipts-home hidden aurora-receipts-view"/);
  assert.match(html, /class="shop-home hidden aurora-shop-view"/);
  assert.match(html, /class="hidden aurora-pos-view"/);
  assert.match(html, /aurora-section-intro/);
  assert.match(html, /aurora-receipt-issue/);
  assert.match(html, /aurora-receipt-verify/);
  assert.match(html, /aurora-receipt-declaration/);
  assert.match(html, /aurora-stat-sales/);
  assert.match(html, /aurora-stat-profit/);
  assert.match(html, /aurora-stat-debt/);
  assert.match(html, /aurora-stat-stock/);
  assert.match(html, /aurora-compare-sales/);
  assert.match(html, /aurora-channel-pos/);

  const modernCss = read('../frontend/aurora-modern.css');
  assert.match(modernCss, /\.aurora-login-story/);
  assert.match(modernCss, /\.aurora-dashboard-hero/);
  assert.match(modernCss, /\.aurora-art-sheet/);
  assert.match(app, /aurora-hero-actions[\s\S]*?showWorkspaceScreen\(button\.dataset\.workspace\)/);
});
