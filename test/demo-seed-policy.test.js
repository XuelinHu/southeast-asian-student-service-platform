const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getDemoSeedOptions, demoUserDuplicateUpdate } = require('../src/services/demoSeedPolicy');
const { schemaForDatabase } = require('../src/initDb');
const { runMigrationsWithLedger } = require('../src/services/migrationLedger');

const validPassword = 'T3st-Demo-Password-2026!';
const validDatabase = 'international_student_platform_test';

function validEnv(extra = {}) {
  return {
    DB_NAME: validDatabase,
    DEMO_SEED_DATABASE: validDatabase,
    ALLOW_DEMO_SEED: '1',
    DEMO_SEED_PASSWORD: validPassword,
    ...extra
  };
}

test('demo seed is disabled unless explicitly enabled', () => {
  assert.throws(() => getDemoSeedOptions({}, []), /ALLOW_DEMO_SEED=1/);
});

test('demo seed is always rejected in production', () => {
  assert.throws(() => getDemoSeedOptions({
    NODE_ENV: 'production',
    ...validEnv()
  }, []), /disabled in production/);
});

test('demo seed requires an isolated database with an exact opt-in name', () => {
  assert.throws(() => getDemoSeedOptions(validEnv({
    DB_NAME: 'international_student_platform',
    DEMO_SEED_DATABASE: 'international_student_platform'
  }), []), /ending in _dev, _test, or _demo/);
  assert.throws(() => getDemoSeedOptions(validEnv({
    DEMO_SEED_DATABASE: 'another_test'
  }), []), /exact DEMO_SEED_DATABASE match/);
});

test('demo seed requires a strong locally supplied password', () => {
  assert.throws(() => getDemoSeedOptions(validEnv({
    DEMO_SEED_PASSWORD: 'weak'
  }), []), /at least 16 characters/);
  assert.deepEqual(getDemoSeedOptions(validEnv(), []), {
    database: validDatabase,
    password: validPassword,
    resetDemoPasswords: false
  });
});

test('existing demo accounts are preserved unless password reset is explicit', () => {
  const safeUpdate = demoUserDuplicateUpdate(false);
  assert.match(safeUpdate, /password_hash = password_hash/);
  assert.match(safeUpdate, /role_id = role_id/);
  assert.match(safeUpdate, /status = status/);

  const resetUpdate = demoUserDuplicateUpdate(true);
  assert.match(resetUpdate, /password_hash = IF\(id = VALUES\(id\), VALUES\(password_hash\), password_hash\)/);
  assert.match(resetUpdate, /status = status/);
});

test('schema initialization does not create fixed demo users or reset passwords', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../database/schema.sql'), 'utf8');
  assert.doesNotMatch(schema, /INSERT\s+(?:IGNORE\s+)?INTO\s+users/i);
  assert.doesNotMatch(schema, /UPDATE\s+users\s+SET\s+password_hash/i);
  assert.doesNotMatch(schema, /Admin@123|JGOz7ZAw/);
});

test('public login form does not prefill a demo username or password', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.doesNotMatch(html, /name="username"[^>]*\bvalue=/);
  assert.doesNotMatch(html, /name="password"[^>]*\bvalue=/);
  assert.doesNotMatch(html, /Admin@123/);
});

test('schema initialization targets DB_NAME and rejects unsafe identifiers', () => {
  const schema = 'CREATE DATABASE IF NOT EXISTS international_student_platform; USE international_student_platform;';
  assert.equal(
    schemaForDatabase(schema, 'international_student_platform_dev'),
    'CREATE DATABASE IF NOT EXISTS international_student_platform_dev; USE international_student_platform_dev;'
  );
  assert.throws(() => schemaForDatabase(schema, 'dev; DROP DATABASE production'), /only ASCII letters/);
});

test('migration ledger applies once, skips unchanged versions, and rejects drift', async () => {
  const ledger = new Map();
  const calls = [];
  const connection = {
    async query(sql, params = []) {
      calls.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      if (sql.includes('SELECT checksum FROM schema_migrations')) {
        const checksum = ledger.get(params[0]);
        return [[...(checksum ? [{ checksum }] : [])], []];
      }
      if (sql.includes('INSERT INTO schema_migrations')) {
        ledger.set(params[0], params[1]);
        return [{ affectedRows: 1 }, []];
      }
      return [{ affectedRows: 0 }, []];
    }
  };
  let effects = 0;
  const migration = { name: '001 test baseline', async up() { effects += 1; } };

  const first = await runMigrationsWithLedger(connection, 'platform_test', [migration]);
  const second = await runMigrationsWithLedger(connection, 'platform_test', [migration]);
  assert.deepEqual(first.applied, ['001 test baseline']);
  assert.deepEqual(second.skipped, ['001 test baseline']);
  assert.equal(effects, 1);

  const edited = { name: migration.name, async up() { effects += 2; } };
  await assert.rejects(runMigrationsWithLedger(connection, 'platform_test', [edited]), /Applied migration was modified/);
  assert.equal(effects, 1);
});

test('failed migrations are not entered in the ledger and dry-run executes no SQL', async () => {
  const ledger = new Map();
  let executedSql = 0;
  const connection = {
    async query(sql, params = []) {
      executedSql += 1;
      if (sql.includes('SELECT checksum FROM schema_migrations')) {
        const checksum = ledger.get(params[0]);
        return [[...(checksum ? [{ checksum }] : [])], []];
      }
      if (sql.includes('INSERT INTO schema_migrations')) ledger.set(params[0], params[1]);
      return [{ affectedRows: 0 }, []];
    }
  };
  const broken = { name: '002 broken', async up() { throw new Error('DDL failed'); } };
  await assert.rejects(runMigrationsWithLedger(connection, 'platform_test', [broken]), /DDL failed/);
  assert.equal(ledger.has(broken.name), false);

  const countBeforeDryRun = executedSql;
  const dry = await runMigrationsWithLedger(connection, 'platform_test', [broken], { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(executedSql, countBeforeDryRun);
});
