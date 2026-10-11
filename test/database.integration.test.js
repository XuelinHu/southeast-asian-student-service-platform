require('dotenv').config();

const assert = require('node:assert/strict');
const { test } = require('node:test');

const enabled = process.env.RUN_DB_INTEGRATION === '1';
if (enabled) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Database integration tests cannot run in production.');
  }
  if (!/(?:_dev|_test|_demo)$/i.test(process.env.DB_NAME || '')) {
    throw new Error('Database integration tests require a DB_NAME ending in _dev, _test, or _demo.');
  }
  if (!process.env.DEMO_SEED_PASSWORD) {
    throw new Error('DEMO_SEED_PASSWORD is required for database integration tests.');
  }
}

test('database-backed auth, RBAC, pagination, and logout revocation', { skip: !enabled }, async () => {
  const app = require('../src/server');
  const pool = require('../src/config/db');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function login(username, password = process.env.DEMO_SEED_PASSWORD) {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    return { response, body: await response.json() };
  }

  try {
    const anonymous = await fetch(`${base}/api/students`);
    assert.equal(anonymous.status, 401);

    const invalid = await login('admin', 'invalid-test-password');
    assert.equal(invalid.response.status, 401);

    const adminLogin = await login('admin');
    assert.equal(adminLogin.response.status, 200);
    assert.equal(adminLogin.body.user.role, 'super_admin');
    const adminAuth = { authorization: `Bearer ${adminLogin.body.token}` };

    const profile = await fetch(`${base}/api/auth/me`, { headers: adminAuth });
    assert.equal(profile.status, 200);

    const firstResponse = await fetch(`${base}/api/admin/users?page=1&pageSize=10`, { headers: adminAuth });
    const first = await firstResponse.json();
    assert.equal(firstResponse.status, 200);
    assert.equal(first.items.length, 10);
    assert.ok(first.total >= 300);

    const secondResponse = await fetch(`${base}/api/admin/users?page=2&pageSize=10`, { headers: adminAuth });
    const second = await secondResponse.json();
    assert.equal(secondResponse.status, 200);
    assert.equal(second.items.length, 10);
    assert.notEqual(first.items[0].id, second.items[0].id);

    const studentLogin = await login('student01');
    assert.equal(studentLogin.response.status, 200);
    const forbidden = await fetch(`${base}/api/admin/users?page=1`, {
      headers: { authorization: `Bearer ${studentLogin.body.token}` }
    });
    assert.equal(forbidden.status, 403);

    const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: adminAuth });
    assert.equal(logout.status, 200);
    const revoked = await fetch(`${base}/api/auth/me`, { headers: adminAuth });
    assert.equal(revoked.status, 401);

    const reLogin = await login('admin');
    assert.equal(reLogin.response.status, 200);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.end();
  }
});
