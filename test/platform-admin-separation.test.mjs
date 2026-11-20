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
  // The hidden value is required by the separate admin URL mode, but is not an ordinary login choice.
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



test('previous AURORA workspace page layout is restored without the new redesign stylesheet', () => {
  assert.doesNotMatch(html, /aurora-modern\\.css/);
  assert.match(html, /id="workspace-nav"/);
  assert.match(html, /id="receipts-home"/);
  assert.match(html, /id="shop-home"/);
  assert.match(html, /id="owner-dashboard-view"/);
  assert.match(html, /id="owner-home"/);
  assert.doesNotMatch(html, /id="platform-referral-admin"/);
  assert.match(app, /window\\.location\\.replace\\('\.\\/admin\\.html'\\)/);
  assert.match(read('../frontend/admin.html'), /Admin Control Centre/);
});
