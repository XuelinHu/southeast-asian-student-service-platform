const test = require('node:test');
const assert = require('node:assert/strict');
const { migrationLockName, withMigrationLock } = require('../src/services/migrationLock');

function createConnection(acquired = 1) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('GET_LOCK')) return [[{ acquired }], []];
      if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }], []];
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}

test('migration lock name is stable and isolated by database', () => {
  assert.equal(migrationLockName('platform_test'), migrationLockName('platform_test'));
  assert.notEqual(migrationLockName('platform_test'), migrationLockName('platform_demo'));
  assert.ok(migrationLockName('platform_test').length <= 64);
});

test('migration lock is released after a successful operation', async () => {
  const connection = createConnection();
  const result = await withMigrationLock(connection, 'platform_test', async () => 'migrated');
  assert.equal(result, 'migrated');
  assert.deepEqual(connection.calls.map((call) => call.sql), [
    'SELECT GET_LOCK(?, 15) AS acquired',
    'SELECT RELEASE_LOCK(?)'
  ]);
  assert.equal(connection.calls[0].params[0], connection.calls[1].params[0]);
});

test('migration lock is released when a migration fails', async () => {
  const connection = createConnection();
  await assert.rejects(
    withMigrationLock(connection, 'platform_test', async () => { throw new Error('DDL failed'); }),
    /DDL failed/
  );
  assert.equal(connection.calls.filter((call) => call.sql.includes('RELEASE_LOCK')).length, 1);
});

test('migration stops without running or releasing when the database lock is unavailable', async () => {
  const connection = createConnection(0);
  let ran = false;
  await assert.rejects(
    withMigrationLock(connection, 'platform_test', async () => { ran = true; }),
    /Could not acquire the database migration lock/
  );
  assert.equal(ran, false);
  assert.equal(connection.calls.length, 1);
  assert.match(connection.calls[0].sql, /GET_LOCK/);
});

test('overlapping migrations for the same database cannot both acquire the lock', async () => {
  let locked = false;
  const connection = {
    async query(sql) {
      if (sql.includes('GET_LOCK')) {
        if (locked) return [[{ acquired: 0 }], []];
        locked = true;
        return [[{ acquired: 1 }], []];
      }
      if (sql.includes('RELEASE_LOCK')) {
        locked = false;
        return [[{ released: 1 }], []];
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };

  let finishFirst;
  const first = withMigrationLock(connection, 'platform_test', () => new Promise((resolve) => { finishFirst = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    withMigrationLock(connection, 'platform_test', async () => 'must not run'),
    /Could not acquire the database migration lock/
  );
  finishFirst('done');
  assert.equal(await first, 'done');
  assert.equal(locked, false);
});
