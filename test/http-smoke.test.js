const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PGPASSWORD ||= 'http-smoke-test-only';
process.env.JWT_SECRET ||= 'http-smoke-jwt-secret-for-tests';

const app = require('../src/server');

let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (!server) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('health and static entrypoint respond without a database connection', async () => {
  const [healthResponse, pageResponse] = await Promise.all([
    fetch(`${baseUrl}/api/health`),
    fetch(baseUrl)
  ]);
  const health = await healthResponse.json();
  const html = await pageResponse.text();

  assert.equal(healthResponse.status, 200);
  assert.equal(health.status, 'ok');
  assert.equal(health.name, 'international-student-platform');
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get('content-type'), /text\/html/);
  assert.match(html, /<html/i);
})

test('anonymous visitor receives a random HttpOnly SameSite cookie', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const cookie = response.headers.get('set-cookie') || '';

  assert.match(cookie, /vid=[a-f0-9]{32}/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
})

test('protected student data is rejected before reaching the database', async () => {
  const response = await fetch(`${baseUrl}/api/students`);
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.message, 'Missing authorization token');
})

test('unknown routes return 404', async () => {
  const response = await fetch(`${baseUrl}/api/unknown-smoke-route`);
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.message, 'Not found');
})

test('malformed and oversized JSON return sanitized client errors', async () => {
  const malformed = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"username":'
  });
  const malformedBody = await malformed.json();
  assert.equal(malformed.status, 400);
  assert.equal(malformedBody.code, 'invalid_json');
  assert.doesNotMatch(malformedBody.message, /Unexpected|JSON.parse|stack/i);

  const oversized = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(10 * 1024 * 1024) })
  });
  const oversizedBody = await oversized.json();
  assert.equal(oversized.status, 413);
  assert.equal(oversizedBody.code, 'payload_too_large');
})
