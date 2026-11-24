import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const { Reflector } = require('@nestjs/core');
const { ForbiddenException } = require('@nestjs/common');
const { Roles, RolesGuard } = require('../src/auth/auth.ts');

function contextFor(controller, handler, user) {
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user, originalUrl: '/api/v1/platform-admin/overview' }) }),
  };
}

test('controller-level super_admin role is enforced on methods without method metadata', () => {
  class PlatformAdminFixture {}
  Roles('super_admin')(PlatformAdminFixture);
  const handler = function overview() {};
  const guard = new RolesGuard(new Reflector());

  assert.throws(
    () => guard.canActivate(contextFor(PlatformAdminFixture, handler, { role: 'owner' })),
    ForbiddenException,
  );
  assert.equal(guard.canActivate(contextFor(PlatformAdminFixture, handler, { role: 'super_admin' })), true);
});

test('method-level role metadata overrides controller-level role metadata', () => {
  class MixedRoleFixture {}
  Roles('super_admin')(MixedRoleFixture);
  const handler = function publicForOwner() {};
  Roles('owner')(handler);
  const guard = new RolesGuard(new Reflector());

  assert.equal(guard.canActivate(contextFor(MixedRoleFixture, handler, { role: 'owner' })), true);
  assert.throws(
    () => guard.canActivate(contextFor(MixedRoleFixture, handler, { role: 'super_admin' })),
    ForbiddenException,
  );
});

test('vendor and freelancer workspace mapping does not grant platform-admin access', () => {
  class PlatformAdminFixture {}
  Roles('super_admin')(PlatformAdminFixture);
  const handler = function overview() {};
  const guard = new RolesGuard(new Reflector());

  for (const role of ['vendor', 'freelancer', 'cashier', 'customer']) {
    assert.throws(
      () => guard.canActivate(contextFor(PlatformAdminFixture, handler, { role })),
      ForbiddenException,
      role,
    );
  }
});
