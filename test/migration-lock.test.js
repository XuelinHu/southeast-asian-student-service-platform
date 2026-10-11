const test = require('node:test');
const assert = require('node:assert/strict');
const { migrationLockName, withMigrationLock } = require('../src/services/migrationLock');

function createConnection() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ pg_advisory_lock: null }], rowCount: 1 };
    }
  };
}

test('PostgreSQL advisory lock keys are stable and isolated by project database', () => {
  assert.equal(migrationLockName('platform_test'), migrationLockName('platform_test'));
  assert.notEqual(migrationLockName('platform_test'), migrationLockName('platform_demo'));
  assert.match(migrationLockName('platform_test'), /^student-platform:migrate:/);
});

test('migration lock releases after successful migration', async () => {
  const connection = createConnection();
  const result = await withMigrationLock(connection, 'platform_test', async () => 'migrated');
  assert.equal(result, 'migrated');
  assert.deepEqual(connection.calls.map((call) => call.sql), [
    'SELECT pg_advisory_lock(hashtextextended($1, 0))',
    'SELECT pg_advisory_unlock(hashtextextended($1, 0))'
  ]);
  assert.equal(connection.calls[0].params[0], connection.calls[1].params[0]);
});

test('migration lock releases when migration fails', async () => {
  const connection = createConnection();
  await assert.rejects(
    withMigrationLock(connection, 'platform_test', async () => { throw new Error('DDL failed'); }),
    /DDL failed/
  );
  assert.equal(connection.calls.at(-1).sql, 'SELECT pg_advisory_unlock(hashtextextended($1, 0))');
});
