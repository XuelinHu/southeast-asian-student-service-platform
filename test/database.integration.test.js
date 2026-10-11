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

    const optionsFirstResponse = await fetch(
      `${base}/api/admin/users/options?field=roleId&page=1&pageSize=2`,
      { headers: adminAuth }
    );
    const optionsFirst = await optionsFirstResponse.json();
    assert.equal(optionsFirstResponse.status, 200);
    assert.equal(optionsFirst.items.length, 2);
    assert.equal(optionsFirst.page, 1);
    assert.equal(optionsFirst.pageSize, 2);
    assert.ok(optionsFirst.total >= 3);
    assert.equal(optionsFirst.totalPages, Math.ceil(optionsFirst.total / 2));

    const optionsSecondResponse = await fetch(
      `${base}/api/admin/users/options?field=roleId&page=2&pageSize=2`,
      { headers: adminAuth }
    );
    const optionsSecond = await optionsSecondResponse.json();
    assert.equal(optionsSecondResponse.status, 200);
    assert.equal(optionsSecond.items.length, 2);
    assert.equal(optionsSecond.page, 2);
    assert.ok(optionsFirst.items.every((item) => !optionsSecond.items.some((other) => item.value === other.value)));

    const classOptionsFirstResponse = await fetch(
      `${base}/api/admin/students/options?field=classId&page=1&pageSize=100`,
      { headers: adminAuth }
    );
    const classOptionsFirst = await classOptionsFirstResponse.json();
    assert.equal(classOptionsFirstResponse.status, 200);
    assert.equal(classOptionsFirst.items.length, 100);
    assert.ok(classOptionsFirst.total >= 120);
    assert.equal(classOptionsFirst.totalPages, Math.ceil(classOptionsFirst.total / 100));

    const classOptionsSecondResponse = await fetch(
      `${base}/api/admin/students/options?field=classId&page=2&pageSize=100`,
      { headers: adminAuth }
    );
    const classOptionsSecond = await classOptionsSecondResponse.json();
    assert.equal(classOptionsSecondResponse.status, 200);
    assert.ok(classOptionsSecond.items.length > 0 && classOptionsSecond.items.length <= 100);
    assert.ok(classOptionsFirst.items.every((item) => !classOptionsSecond.items.some((other) => item.value === other.value)));

    const nationalitiesFirstResponse = await fetch(
      `${base}/api/management/nationalities?page=1&pageSize=20`,
      { headers: adminAuth }
    );
    const nationalitiesFirst = await nationalitiesFirstResponse.json();
    assert.equal(nationalitiesFirstResponse.status, 200);
    assert.equal(nationalitiesFirst.items.length, 20);
    assert.equal(nationalitiesFirst.page, 1);
    assert.ok(nationalitiesFirst.total >= 120);

    const nationalitiesSecondResponse = await fetch(
      `${base}/api/management/nationalities?page=2&pageSize=20`,
      { headers: adminAuth }
    );
    const nationalitiesSecond = await nationalitiesSecondResponse.json();
    assert.equal(nationalitiesSecondResponse.status, 200);
    assert.equal(nationalitiesSecond.items.length, 20);
    assert.ok(nationalitiesFirst.items.every((item) => !nationalitiesSecond.items.some((other) => item.id === other.id)));

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
