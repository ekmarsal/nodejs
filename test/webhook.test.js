// Smoke tests for the webhook security boundary.
// Postgres is stubbed so these run with no infrastructure: `npm test`.
const assert = require('node:assert');
const crypto = require('node:crypto');
const Module = require('node:module');
const test = require('node:test');

// ---- Stub `pg` before app.js requires it -------------------------------
const queries = [];
const stubPool = {
  query: async (text, params) => {
    queries.push({ text, params });
    if (/SELECT 1 FROM webhook_events WHERE payload_hash/.test(text)) return { rowCount: 0, rows: [] };
    if (/COUNT\(\*\)/.test(text)) return { rowCount: 1, rows: [{ count: '42' }] };
    if (/RETURNING id/.test(text)) return { rowCount: 1, rows: [{ id: 1 }] };
    return { rowCount: 0, rows: [] };
  },
  connect: async () => ({ query: stubPool.query, release: () => {} }),
  on: () => {},
  end: async () => {},
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'pg') return 'pg-stub';
  return originalResolve.call(this, request, ...rest);
};
require.cache['pg-stub'] = { id: 'pg-stub', filename: 'pg-stub', loaded: true, exports: { Pool: function () { return stubPool; } } };

const SECRET = 'test-webhook-secret';
const ADMIN_TOKEN = 'a'.repeat(40);
process.env.FAREHARBOR_WEBHOOK_SECRET = SECRET;
process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;

const { app, extractStatus, extractAmount } = require('../app');

// ---- Minimal HTTP client ----------------------------------------------
let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => server && server.close());

function sign(body) {
  return crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}

const PAYLOAD = JSON.stringify({
  type: 'booking.created',
  booking: {
    pk: 998877,
    status: 'booked',
    receipt_total: 57000,
    source_type: 'online',
    availability: { start_at: '2026-09-01T14:00:00-0400', item: { name: 'DC at Dusk' } },
    contact: { name: 'Test Person', email: 'test@example.com', phone: '+12025550100' },
    customer_type_rates: [{ quantity: 2 }],
    payments: [{ amount: 57000, card_number: '4111111111111111' }],
    custom_field_values: [{ custom_field: { title: 'Any allergies?' }, value: 'peanuts' }],
  },
});

async function postWebhook(body, headers = {}) {
  return fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

// ---- Tests -------------------------------------------------------------

test('unsigned webhook is rejected', async () => {
  const res = await postWebhook(PAYLOAD);
  assert.strictEqual(res.status, 401);
});

test('webhook with a wrong signature is rejected', async () => {
  const res = await postWebhook(PAYLOAD, { 'x-fareharbor-signature': 'deadbeef' });
  assert.strictEqual(res.status, 401);
});

test('correctly signed webhook is accepted', async () => {
  const res = await postWebhook(PAYLOAD, { 'x-fareharbor-signature': `sha256=${sign(PAYLOAD)}` });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).status, 'success');
});

test('card data and special-category answers never reach the database', async () => {
  const inserts = queries.filter((q) => /INSERT INTO (bookings|webhook_events)/.test(q.text));
  assert.ok(inserts.length > 0, 'expected booking/event inserts');
  const persisted = JSON.stringify(inserts.map((q) => q.params));
  assert.ok(!persisted.includes('4111111111111111'), 'card number was persisted');
  assert.ok(!persisted.includes('peanuts'), 'allergy answer was persisted');
  assert.ok(persisted.includes('[REDACTED]'), 'redaction markers missing');
});

test('malformed JSON is rejected with 400, not 500', async () => {
  const res = await postWebhook('{not json', { 'x-fareharbor-signature': `sha256=${sign('{not json')}` });
  assert.strictEqual(res.status, 400);
});

test('/stats requires a bearer token', async () => {
  assert.strictEqual((await fetch(`${baseUrl}/stats`)).status, 401);
  assert.strictEqual(
    (await fetch(`${baseUrl}/stats`, { headers: { Authorization: 'Bearer wrong-token' } })).status,
    401
  );
  assert.strictEqual(
    (await fetch(`${baseUrl}/stats`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } })).status,
    200
  );
});

test('/health exposes no business metrics', async () => {
  const body = await (await fetch(`${baseUrl}/health`)).json();
  assert.ok(!('totalBookings' in body), '/health still leaks booking volume');
});

test('/ does not advertise protected endpoints', async () => {
  const body = await (await fetch(`${baseUrl}/`)).text();
  assert.ok(!body.includes('/stats'), 'root banner still enumerates /stats');
});

test('no wildcard CORS header is sent', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.notStrictEqual(res.headers.get('access-control-allow-origin'), '*');
});

test('privacy endpoints require a bearer token', async () => {
  assert.strictEqual((await fetch(`${baseUrl}/privacy/subject?email=a@b.com`)).status, 401);
  const res = await fetch(`${baseUrl}/privacy/erase`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'a@b.com' }),
  });
  assert.strictEqual(res.status, 401);
});

test('booking status is mapped correctly (regression: precedence bug)', () => {
  assert.strictEqual(extractStatus({ status: 'booked' }), 'confirmed');
  assert.strictEqual(extractStatus({ status: 'cancelled' }), 'cancelled');
  assert.strictEqual(extractStatus({ status: 'booked', rebooked_to: 12 }), 'rebooked');
  assert.strictEqual(extractStatus({}), 'confirmed');
});

test('amounts are converted from cents', () => {
  assert.strictEqual(extractAmount({ receipt_total: 57000 }), '570.00');
  assert.strictEqual(extractAmount({}), '0.00');
});
