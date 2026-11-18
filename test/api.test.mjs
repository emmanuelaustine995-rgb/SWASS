// Integration tests for the SWASS API. They call a RUNNING server over HTTP and
// check the results in the database, so use a throwaway database, not production.
//
//   DATABASE_URL=postgres://.../swass_test JWT_SECRET=x SWASS_ID_SECRET=y npm run start:dev   (terminal 1)
//   DATABASE_URL=postgres://.../swass_test npm run test:api                                    (terminal 2)
//
// Each test creates its own shop, so tests do not affect each other.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const PASSWORD = 'Test-pass-123';
const run = randomBytes(3).toString('hex');
let seq = 0;

after(() => pool.end());

const randomPhone = () => `07${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const q = (sql, params) => pool.query(sql, params);

async function addUser(tenantId, storeId, role, name) {
  const phone = randomPhone();
  await q(
    `INSERT INTO users (tenant_id, store_id, full_name, phone, password_hash, role)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [tenantId, storeId, name, phone, await argon2.hash(PASSWORD), role],
  );
  return phone;
}

/** Creates a shop with a cashier, a manager, two products, a subscription and a wallet. */
async function makeShop({ subscribed = true, walletKes = 50 } = {}) {
  const tenantId = (await q(`INSERT INTO tenants (name, phone) VALUES ($1,$2) RETURNING id`,
    [`Shop ${run}-${++seq}`, randomPhone()])).rows[0].id;
  const storeId = (await q(`INSERT INTO stores (tenant_id, name) VALUES ($1,'Main') RETURNING id`, [tenantId])).rows[0].id;
  const cashier = await addUser(tenantId, storeId, 'cashier', 'Faith');
  const manager = await addUser(tenantId, storeId, 'manager', 'Otieno');

  if (subscribed) {
    await q(`INSERT INTO subscriptions (tenant_id, plan, price_kes, starts_at, ends_at, status)
             VALUES ($1,'monthly',100, now() - interval '1 day', now() + interval '30 days', 'active')`, [tenantId]);
  } else {
    await q(`INSERT INTO subscriptions (tenant_id, plan, price_kes, starts_at, ends_at, status)
             VALUES ($1,'monthly',100, now() - interval '40 days', now() - interval '10 days', 'active')`, [tenantId]);
  }
  await q(`INSERT INTO wallets (tenant_id, balance_kes) VALUES ($1,$2)`, [tenantId, walletKes]);

  const item = (await q(
    `INSERT INTO products (tenant_id, store_id, name, price_kes, stock_qty)
     VALUES ($1,$2,'USB Cable',1000,10) RETURNING id`, [tenantId, storeId])).rows[0].id;
  const phoneProduct = (await q(
    `INSERT INTO products (tenant_id, store_id, name, price_kes, stock_qty, requires_buyer_id)
     VALUES ($1,$2,'Samsung A15',18500,5,true) RETURNING id`, [tenantId, storeId])).rows[0].id;

  return { tenantId, storeId, cashier, manager, item, phoneProduct };
}

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: json };
}

async function login(phone, password = PASSWORD) {
  const r = await call('POST', '/api/v1/auth/login', { phone, password });
  return r.status < 300 ? r.body.accessToken : null;
}

const payload = (productId, extra = {}) => ({
  clientUuid: randomUUID(),
  receiptNo: `T-${run}-${++seq}`,
  paymentMethod: 'cash',
  items: [{ productId, qty: 1 }],
  ...extra,
});

const wallet = async (tenantId) => Number((await q(`SELECT balance_kes FROM wallets WHERE tenant_id=$1`, [tenantId])).rows[0].balance_kes);
const stock = async (productId) => Number((await q(`SELECT stock_qty FROM products WHERE id=$1`, [productId])).rows[0].stock_qty);
const receiptCount = async (tenantId) => Number((await q(`SELECT count(*) FROM receipts WHERE tenant_id=$1`, [tenantId])).rows[0].count);

// ---------------------------------------------------------------- login

test('login: wrong password and unknown phone both give 401', async () => {
  const s = await makeShop();
  assert.equal((await call('POST', '/api/v1/auth/login', { phone: s.cashier, password: 'nope' })).status, 401);
  assert.equal((await call('POST', '/api/v1/auth/login', { phone: '0700000001', password: PASSWORD })).status, 401);
  assert.ok(await login(s.cashier));
});


test('login: users of suspended or closed shops cannot sign in', async () => {
  const suspended = await makeShop();
  await q(`UPDATE tenants SET status='suspended' WHERE id=$1`, [suspended.tenantId]);
  assert.equal((await call('POST', '/api/v1/auth/login', { phone: suspended.cashier, password: PASSWORD })).status, 401);

  const closed = await makeShop();
  await q(`UPDATE tenants SET status='closed' WHERE id=$1`, [closed.tenantId]);
  assert.equal((await call('POST', '/api/v1/auth/login', { phone: closed.cashier, password: PASSWORD })).status, 401);
});

test('receipts: no token gives 401', async () => {
  const s = await makeShop();
  assert.equal((await call('POST', '/api/v1/receipts', payload(s.item))).status, 401);
});

test('receipts: a super-admin cannot issue receipts (403)', async () => {
  const phone = randomPhone();
  await q(`INSERT INTO users (tenant_id, full_name, phone, password_hash, role) VALUES (NULL,'Root',$1,$2,'super_admin')`,
    [phone, await argon2.hash(PASSWORD)]);
  const s = await makeShop();
  const token = await login(phone);
  assert.equal((await call('POST', '/api/v1/receipts', payload(s.item), token)).status, 403);
});

// ---------------------------------------------------------------- creating a receipt

test('create: prices come from the database, stock and wallet change', async () => {
  const s = await makeShop();
  const token = await login(s.cashier);
  const body = payload(s.item, { items: [{ productId: s.item, qty: 3, unitPriceKes: 1 }] }); // client price is ignored

  const r = await call('POST', '/api/v1/receipts', body, token);
  assert.equal(r.status, 201);
  assert.equal(r.body.totalKes, 3000);
  assert.equal(r.body.duplicate, false);
  assert.ok(r.body.qrToken.length >= 20);
  assert.equal(await stock(s.item), 7);
  assert.equal(await wallet(s.tenantId), 48);
});

test('create: retrying the same clientUuid does not double charge or double deduct', async () => {
  const s = await makeShop();
  const token = await login(s.cashier);
  const body = payload(s.item);

  const first = await call('POST', '/api/v1/receipts', body, token);
  const second = await call('POST', '/api/v1/receipts', body, token);

  assert.equal(first.status, 201);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.id, first.body.id);
  assert.equal(await receiptCount(s.tenantId), 1);
  assert.equal(await wallet(s.tenantId), 48);
  assert.equal(await stock(s.item), 9);
});

test('create: two identical requests at the same moment still make one receipt', async () => {
  const s = await makeShop();
  const token = await login(s.cashier);
  const body = payload(s.item);

  const [a, b] = await Promise.all([
    call('POST', '/api/v1/receipts', body, token),
    call('POST', '/api/v1/receipts', body, token),
  ]);

  assert.ok(a.status < 300 && b.status < 300);
  assert.equal(await receiptCount(s.tenantId), 1);
  assert.equal(await wallet(s.tenantId), 48);
});

test('create: a sale can take stock below zero (offline sale of a sold-out item)', async () => {
  const s = await makeShop();
  const token = await login(s.cashier);
  const r = await call('POST', '/api/v1/receipts', payload(s.item, { items: [{ productId: s.item, qty: 12 }] }), token);
  assert.equal(r.status, 201);
  assert.equal(await stock(s.item), -2);
});

test('create: an item from another shop is rejected', async () => {
  const mine = await makeShop();
  const other = await makeShop();
  const token = await login(mine.cashier);
  assert.equal((await call('POST', '/api/v1/receipts', payload(other.item), token)).status, 400);
  assert.equal(await receiptCount(mine.tenantId), 0);
});

test('create: bad input is rejected with 400', async () => {
  const s = await makeShop();
  const token = await login(s.cashier);
  assert.equal((await call('POST', '/api/v1/receipts', { ...payload(s.item), clientUuid: 'abc' }, token)).status, 400);
  assert.equal((await call('POST', '/api/v1/receipts', { ...payload(s.item), items: [] }, token)).status, 400);
  assert.equal((await call('POST', '/api/v1/receipts', { ...payload(s.item), items: [{ productId: s.item, qty: 0 }] }, token)).status, 400);
  assert.equal((await call('POST', '/api/v1/receipts', { ...payload(s.item), paymentMethod: 'cheque' }, token)).status, 400);
  assert.equal(await receiptCount(s.tenantId), 0);
});

// ---------------------------------------------------------------- money rules

test('billing: an expired subscription (past the 3 day grace) gives 402', async () => {
  const s = await makeShop({ subscribed: false });
  const token = await login(s.cashier);
  const r = await call('POST', '/api/v1/receipts', payload(s.item), token);
  assert.equal(r.status, 402);
  assert.equal(await receiptCount(s.tenantId), 0);
  assert.equal(await wallet(s.tenantId), 50);
});

test('billing: a wallet past its overdraft limit gives 402 and saves nothing', async () => {
  const s = await makeShop({ walletKes: -99 }); // -99 minus the KSh 2 fee would pass -100
  const token = await login(s.cashier);
  const r = await call('POST', '/api/v1/receipts', payload(s.item), token);
  assert.equal(r.status, 402);
  assert.equal(await receiptCount(s.tenantId), 0);
  assert.equal(await stock(s.item), 10);
});

test('billing: the last receipt inside the overdraft is accepted', async () => {
  const s = await makeShop({ walletKes: -98 }); // -98 minus 2 lands exactly on -100
  const token = await login(s.cashier);
  assert.equal((await call('POST', '/api/v1/receipts', payload(s.item), token)).status, 201);
  assert.equal(await wallet(s.tenantId), -100);
});

test('discounts: a cashier is capped at 5%, a manager is not', async () => {
  const s = await makeShop();
  const cashier = await login(s.cashier);
  const manager = await login(s.manager);

  assert.equal((await call('POST', '/api/v1/receipts', payload(s.item, { discountKes: 51 }), cashier)).status, 403);
  const ok = await call('POST', '/api/v1/receipts', payload(s.item, { discountKes: 50 }), cashier);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.totalKes, 950);

  const big = await call('POST', '/api/v1/receipts', payload(s.item, { discountKes: 200 }), manager);
  assert.equal(big.status, 201);
  assert.equal(big.body.totalKes, 800);

  assert.equal((await call('POST', '/api/v1/receipts', payload(s.item, { discountKes: 5000 }), manager)).status, 400);
});

// ---------------------------------------------------------------- buyer details and loyalty

test('buyer: a phone sale needs name, phone and National ID', async () => {
  const s = await makeShop();
  const token = await login(s.cashier);
  const r = await call('POST', '/api/v1/receipts', payload(s.phoneProduct), token);
  assert.equal(r.status, 400);
  assert.equal(await stock(s.phoneProduct), 5);
});

test('buyer: the National ID is stored only as a hash, and points are awarded', async () => {
  const s = await makeShop();
  const token = await login(s.cashier);
  const customer = { fullName: 'J Kamau', phone: '0712345678', nationalId: '12345678' };

  const r = await call('POST', '/api/v1/receipts', payload(s.phoneProduct, { paymentMethod: 'mpesa', customer }), token);
  assert.equal(r.status, 201);
  assert.equal(r.body.pointsEarned, 185); // KSh 18,500 at 1 point per KSh 100

  const row = (await q(`SELECT national_id_hash, national_id_last4, loyalty_points, phone, customers::text AS raw
                          FROM customers WHERE tenant_id=$1`, [s.tenantId])).rows[0];
  assert.equal(row.phone, '254712345678');
  assert.equal(row.national_id_last4, '5678');
  assert.equal(row.national_id_hash.length, 64);
  assert.ok(!row.raw.includes('12345678'), 'the plain National ID must never be stored');
  assert.equal(row.loyalty_points, 185);
});

test('buyer: the same phone on a second sale reuses the customer and adds points', async () => {
  const s = await makeShop();
  const token = await login(s.cashier);
  const customer = { fullName: 'J Kamau', phone: '+254 712 345 678', nationalId: '12345678' };

  await call('POST', '/api/v1/receipts', payload(s.item, { customer }), token);                // 10 points
  await call('POST', '/api/v1/receipts', payload(s.item, { customer: { ...customer, phone: '0712345678' } }), token);

  const rows = (await q(`SELECT loyalty_points FROM customers WHERE tenant_id=$1`, [s.tenantId])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].loyalty_points, 20);
});


test('idempotency: reusing a client UUID with changed sale details gives 409', async () => {
  const s = await makeShop();
  const token = await login(s.cashier);
  const original = payload(s.item);
  assert.equal((await call('POST', '/api/v1/receipts', original, token)).status, 201);
  const altered = { ...original, items: [{ productId: s.item, qty: 2 }] };
  assert.equal((await call('POST', '/api/v1/receipts', altered, token)).status, 409);
  assert.equal(await receiptCount(s.tenantId), 1);
  assert.equal(await wallet(s.tenantId), 48);
  assert.equal(await stock(s.item), 9);
});

test('buyer: a National ID already bound to a phone cannot be replaced', async () => {
  const s = await makeShop();
  const token = await login(s.cashier);
  const customer = { fullName: 'J Kamau', phone: '0712345678', nationalId: '12345678' };
  const first = await call('POST', '/api/v1/receipts', payload(s.phoneProduct, { customer }), token);
  assert.equal(first.status, 201);
  const second = await call('POST', '/api/v1/receipts', payload(s.phoneProduct, {
    customer: { ...customer, nationalId: '87654321' },
  }), token);
  assert.equal(second.status, 409);
  assert.equal(await receiptCount(s.tenantId), 1);
  assert.equal(await stock(s.phoneProduct), 4);
});

// ---------------------------------------------------------------- offline sync

test('sync: good receipts are saved, bad ones are reported, and a re-upload is harmless', async () => {
  const s = await makeShop();
  const token = await login(s.cashier);
  const good = payload(s.item);
  const bad = payload(randomUUID()); // product does not exist

  const first = await call('POST', '/api/v1/receipts/sync', { receipts: [good, bad] }, token);
  assert.equal(first.status, 201);
  assert.equal(first.body.results[0].ok, true);
  assert.equal(first.body.results[1].ok, false);
  assert.equal(await receiptCount(s.tenantId), 1);

  const again = await call('POST', '/api/v1/receipts/sync', { receipts: [good] }, token);
  assert.equal(again.body.results[0].receipt.duplicate, true);
  assert.equal(await receiptCount(s.tenantId), 1);
  assert.equal(await wallet(s.tenantId), 48);
});

test('sync: an offline receipt keeps the till time, but a future time is replaced', async () => {
  const s = await makeShop();
  const token = await login(s.cashier);
  const earlier = new Date(Date.now() - 3 * 3600_000).toISOString();
  const future = new Date(Date.now() + 5 * 86400_000).toISOString();

  const a = payload(s.item, { issuedAt: earlier });
  const b = payload(s.item, { issuedAt: future });
  await call('POST', '/api/v1/receipts/sync', { receipts: [a, b] }, token);

  const t = async (uuid) => new Date((await q(`SELECT issued_at FROM receipts WHERE client_uuid=$1`, [uuid])).rows[0].issued_at).getTime();
  assert.ok(Math.abs((await t(a.clientUuid)) - new Date(earlier).getTime()) < 1000);
  assert.ok((await t(b.clientUuid)) <= Date.now() + 5000);
});

test('create: reusing a receipt number for a different sale gives 409', async () => {
  const s = await makeShop();
  const token = await login(s.cashier);
  const first = payload(s.item);
  await call('POST', '/api/v1/receipts', first, token);
  const clash = payload(s.item, { receiptNo: first.receiptNo }); // new clientUuid, same number
  assert.equal((await call('POST', '/api/v1/receipts', clash, token)).status, 409);
  assert.equal(await receiptCount(s.tenantId), 1);
});

// ---------------------------------------------------------------- inventory management

test('inventory: manager can create, search, edit and adjust stock with an audit entry', async () => {
  const s = await makeShop();
  const token = await login(s.manager);
  const created = await call('POST', '/api/v1/products', {
    name: 'Cooking Oil 1L', sku: 'OIL-1L', barcode: '616100000001',
    priceKes: 250, costKes: 190, stockQty: 12, reorderLevel: 4,
  }, token);
  assert.equal(created.status, 201);
  const id = created.body.product.id;
  assert.equal(created.body.product.stockQty, 12);

  const found = await call('GET', '/api/v1/products?q=Cooking%20Oil', undefined, token);
  assert.equal(found.status, 200);
  assert.ok(found.body.products.some(p => p.id === id));

  const updated = await call('PATCH', `/api/v1/products/${id}`, { priceKes: 275, reorderLevel: 6 }, token);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.product.priceKes, 275);

  const adjusted = await call('POST', `/api/v1/products/${id}/stock-adjustments`, { changeQty: -2, note: 'Damaged stock' }, token);
  assert.equal(adjusted.status, 201);
  assert.equal(adjusted.body.product.stockQty, 10);
  const movement = await q(`SELECT change_qty, reason, note FROM stock_movements WHERE product_id=$1 ORDER BY id DESC LIMIT 1`, [id]);
  assert.equal(movement.rows[0].change_qty, -2);
  assert.equal(movement.rows[0].reason, 'adjustment');
  assert.equal(movement.rows[0].note, 'Damaged stock');
});

test('inventory: cashier can view products but cannot create or adjust them', async () => {
  const s = await makeShop();
  const token = await login(s.cashier);
  assert.equal((await call('GET', '/api/v1/products', undefined, token)).status, 200);
  assert.equal((await call('POST', '/api/v1/products', { name: 'Restricted', priceKes: 10, stockQty: 1 }, token)).status, 403);
});

test('inventory: product validation rejects negative prices and invalid stock changes', async () => {
  const s = await makeShop();
  const token = await login(s.manager);
  assert.equal((await call('POST', '/api/v1/products', { name: 'Bad', priceKes: -1, stockQty: 1 }, token)).status, 400);
  assert.equal((await call('POST', '/api/v1/products', { name: 'Bad', priceKes: 10, stockQty: 1.5 }, token)).status, 400);
});
