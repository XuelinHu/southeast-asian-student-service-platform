import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertSafeRestoreTarget,
  decryptArchive,
  encryptArchive,
  parseEncryptionKey,
  validateDatabaseName
} from '../scripts/database-snapshot.mjs';

test('backup key requires exactly 32 bytes of hexadecimal material', () => {
  assert.equal(parseEncryptionKey('a'.repeat(64)).length, 32);
  assert.throws(() => parseEncryptionKey('short'), /64 hexadecimal/);
  assert.throws(() => parseEncryptionKey('z'.repeat(64)), /64 hexadecimal/);
});

test('restore target must be a different isolated _test database with explicit replacement', () => {
  assert.doesNotThrow(() => assertSafeRestoreTarget({
    sourceDatabase: 'international_student_platform',
    targetDatabase: 'international_student_platform_restore_test',
    replace: true
  }));
  assert.throws(() => assertSafeRestoreTarget({
    sourceDatabase: 'international_student_platform',
    targetDatabase: 'international_student_platform',
    replace: true
  }), /differ from the source/);
  assert.throws(() => assertSafeRestoreTarget({
    sourceDatabase: 'international_student_platform',
    targetDatabase: 'international_student_platform_restore_test',
    replace: false
  }), /--replace/);
  assert.throws(() => assertSafeRestoreTarget({
    sourceDatabase: 'international_student_platform',
    targetDatabase: 'international_student_platform_copy',
    replace: true
  }), /_test/);
  assert.throws(() => validateDatabaseName('student-copy-test'), /safe identifier/);
});

test('encrypted PostgreSQL archives authenticate contents and never overwrite', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sea-pg-snapshot-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dump = path.join(directory, 'database.dump');
  const destination = path.join(directory, 'snapshot.seapg');
  const key = parseEncryptionKey('b'.repeat(64));
  const metadata = {
    format: 1,
    project: 'southeast-asian-student-service-platform',
    database: 'international_student_platform_test',
    createdAt: new Date().toISOString()
  };
  await writeFile(dump, 'custom archive bytes');
  await encryptArchive(dump, destination, metadata, key);

  const restoredDirectory = path.join(directory, 'restored');
  await mkdir(restoredDirectory);
  const { archivePath, metadata: actual } = await decryptArchive(destination, restoredDirectory, key);
  assert.equal(actual.database, metadata.database);
  assert.equal(await readFile(archivePath, 'utf8'), 'custom archive bytes');
  await assert.rejects(encryptArchive(dump, destination, metadata, key), /EEXIST/);

  const tampered = path.join(directory, 'tampered.seapg');
  const bytes = await readFile(destination);
  bytes[bytes.length - 1] ^= 0x01;
  await writeFile(tampered, bytes);
  await mkdir(path.join(directory, 'bad'));
  await mkdir(path.join(directory, 'wrong-key'));
  await assert.rejects(decryptArchive(tampered, path.join(directory, 'bad'), key), /authentication failed/);
  await assert.rejects(decryptArchive(destination, path.join(directory, 'wrong-key'), parseEncryptionKey('c'.repeat(64))), /authentication failed/);
});
