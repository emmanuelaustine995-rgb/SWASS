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
    assert.match(source, /aurora-modern\.css\?v=20261120-sitewide/, page);
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
  assert.match(modernCss, /\.wrap>\.hero/);
  assert.match(modernCss, /\.wrap \.content \.card/);
  for (const page of [
    '../frontend/recover.html',
    '../frontend/verify.html',
    '../frontend/verify-email.html',
    '../frontend/recover-secondhand.html',
    '../frontend/staff-invite.html',
    '../frontend/about.html',
  ]) {
    assert.match(read(page), /aurora-modern\.css\?v=20261120-sitewide/, page);
  }
});

test('ordinary workspace HTML has no duplicate element IDs', () => {
  const ids = [...html.matchAll(/\\bid=["']([^"']+)["']/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size, 'Duplicate IDs can break form and navigation handlers');
});
