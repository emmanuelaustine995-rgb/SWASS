import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../frontend/index.html');
const app = read('../frontend/app.js');

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
