const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/config/db');

const { bindParameters } = pool;

test('PostgreSQL adapter binds positional values without changing quoted text or comments', () => {
  const result = bindParameters("SELECT `user_id`, '?' AS marker FROM users WHERE id = ? -- ?\n", [7]);
  assert.deepEqual(result, {
    text: 'SELECT "user_id", \'?\' AS marker FROM users WHERE id = $1 -- ?\n',
    values: [7]
  });
});

test('PostgreSQL adapter reuses named parameters and ignores PostgreSQL casts', () => {
  const result = bindParameters('SELECT :today::date, :today WHERE name = :name', {
    today: '2026-10-11',
    name: 'sample'
  });
  assert.deepEqual(result, {
    text: 'SELECT $1::date, $1 WHERE name = $2',
    values: ['2026-10-11', 'sample']
  });
});

test('PostgreSQL adapter rejects missing or extra positional parameters', () => {
  assert.throws(() => bindParameters('SELECT ?', []), /parameter count/);
  assert.throws(() => bindParameters('SELECT 1', [1]), /parameter count/);
});
