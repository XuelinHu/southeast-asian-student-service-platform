import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  decodeCell,
  encodeCell,
  assertSafeRestoreTarget,
  getSchemaFingerprint,
  normalizeCreateSql,
  parseEncryptionKey,
  restoreEncryptedSnapshot,
  validateEncryptedSnapshot,
  writeEncryptedSnapshot
} from '../scripts/lib/encryptedSnapshot.mjs';

function makeConnection() {
  return {
    async query(sql, values = []) {
      if (sql.includes('FROM information_schema.TABLES')) return [[{ name: 'users', type: 'BASE TABLE', engine: 'InnoDB', autoIncrement: 3 }]];
      if (sql.includes("SELECT 'trigger' AS kind")) return [[]];
      if (sql.startsWith('SHOW CREATE TABLE')) return [[{ 'Create Table': 'CREATE TABLE `users` (`id` int NOT NULL, `name` varchar(30), PRIMARY KEY (`id`)) ENGINE=InnoDB AUTO_INCREMENT=8' }]];
      if (sql.startsWith('SHOW COLUMNS')) return [[
        { Field: 'id', Type: 'int', Extra: '', Key: 'PRI' },
        { Field: 'name', Type: 'varchar(30)', Extra: '', Key: '' }
      ]];
      if (sql.startsWith('SELECT COUNT(*)')) return [[{ row_count: 2 }]];
      if (sql.startsWith('SELECT `id`, `name`')) {
        if (values.length) return [[]];
        return [[{ id: 1, name: '甲' }, { id: 2, name: '乙' }]];
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}

test('backup key requires exactly 32 bytes of hexadecimal material', () => {
  assert.equal(parseEncryptionKey('a'.repeat(64)).length, 32);
  assert.throws(() => parseEncryptionKey('short'), /64 hexadecimal/);
  assert.throws(() => parseEncryptionKey('z'.repeat(64)), /64 hexadecimal/);
});

test('restore requires an isolated _test database and explicit replace confirmation', () => {
  assert.doesNotThrow(() => assertSafeRestoreTarget({ database: 'student_copy_test', replace: true }));
  assert.throws(() => assertSafeRestoreTarget({ database: 'international_student_platform', replace: true }), /_test/);
  assert.throws(() => assertSafeRestoreTarget({ database: 'student_copy_test', replace: false }), /--replace/);
  assert.throws(() => assertSafeRestoreTarget({ database: 'student-copy-test', replace: true }), /invalid/);
});

test('restore API refuses non-test targets before touching the connection', async () => {
  await assert.rejects(restoreEncryptedSnapshot({
    connection: {}, source: 'unused', key: 'a'.repeat(64), database: 'international_student_platform', replace: true
  }), /_test/);
});

test('binary values round-trip and JSON columns stay JSON', () => {
  const binary = Buffer.from([0, 1, 2, 255]);
  assert.deepEqual(decodeCell(encodeCell(binary), 'longblob'), binary);
  assert.equal(decodeCell({ answer: 42 }, 'json'), '{"answer":42}');
  assert.deepEqual(decodeCell({ answer: 42 }, 'varchar(20)'), { answer: 42 });
});

test('schema fingerprint ignores only mutable auto increment counters', () => {
  assert.equal(normalizeCreateSql('CREATE TABLE t (id int) AUTO_INCREMENT=9'), 'CREATE TABLE t (id int)');
  const base = [{ name: 'users', createSql: 'CREATE TABLE users (id int) AUTO_INCREMENT=9', columns: [{ name: 'id', type: 'int', generated: false }] }];
  const changedCounter = [{ ...base[0], createSql: 'CREATE TABLE users (id int) AUTO_INCREMENT=90' }];
  const changedType = [{ ...base[0], columns: [{ name: 'id', type: 'bigint', generated: false }] }];
  assert.equal(getSchemaFingerprint(base), getSchemaFingerprint(changedCounter));
  assert.notEqual(getSchemaFingerprint(base), getSchemaFingerprint(changedType));
});

test('encrypted snapshot validates completely, rejects tampering, and never overwrites', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'student-platform-snapshot-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'snapshot.seabak');
  const key = 'b'.repeat(64);
  await writeEncryptedSnapshot({ connection: makeConnection(), database: 'student_platform_test', destination, key });
  const manifest = await validateEncryptedSnapshot({ source: destination, key });
  assert.equal(manifest.database, 'student_platform_test');
  assert.equal(manifest.application, 'southeast-asian-student-service-platform');
  assert.equal(manifest.tables[0].rowCount, 2);
  assert.equal(manifest.tables[0].autoIncrement, '3');
  await assert.rejects(
    writeEncryptedSnapshot({ connection: makeConnection(), database: 'student_platform_test', destination, key }),
    /EEXIST/
  );

  const tampered = path.join(directory, 'tampered.seabak');
  const bytes = await readFile(destination);
  bytes[bytes.length - 1] ^= 0x01;
  await writeFile(tampered, bytes);
  await assert.rejects(validateEncryptedSnapshot({ source: tampered, key }));
  await assert.rejects(validateEncryptedSnapshot({ source: destination, key: 'c'.repeat(64) }));
});
