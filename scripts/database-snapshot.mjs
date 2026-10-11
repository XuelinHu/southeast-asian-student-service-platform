import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { assertSafeRestoreTarget, parseEncryptionKey, restoreEncryptedSnapshot, writeEncryptedSnapshot } from './lib/encryptedSnapshot.mjs';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

function usage() {
  console.log('Usage: node scripts/database-snapshot.mjs backup [--destination <file>]');
  console.log('       node scripts/database-snapshot.mjs restore --source <file> --replace');
}

function parseArgs(args) {
  const [command, ...rest] = args;
  if (args.includes('--help') || args.includes('-h')) return { command: 'help' };
  if (!['backup', 'restore'].includes(command)) return null;
  const options = { command, replace: false };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--replace') options.replace = true;
    else if (argument === '--destination' || argument === '--source') {
      const value = rest[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path.`);
      options[argument.slice(2)] = value;
      index += 1;
    } else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!options || options.command === 'help') {
  usage();
  process.exitCode = options ? 0 : 2;
} else {
  const database = process.env.DB_NAME || 'international_student_platform';
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database)) throw new Error('DB_NAME must contain only letters, numbers, and underscores.');
  const key = parseEncryptionKey(process.env.DB_BACKUP_ENCRYPTION_KEY);
  if (options.command === 'restore') {
    if (!options.source) throw new Error('Restore requires --source <file>.');
    assertSafeRestoreTarget({ database, replace: options.replace });
  }
  if (!String(process.env.DB_PASSWORD || '').trim()) throw new Error('DB_PASSWORD is not set.');

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    timezone: 'Z'
  });
  const lockName = `student-platform-backup:${createHash('sha256').update(database).digest('hex').slice(0, 24)}`;
  let locked = false;
  try {
    const [lockRows] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [lockName]);
    if (Number(lockRows[0]?.acquired) !== 1) throw new Error('Timed out waiting for the database migration/backup lock.');
    locked = true;

    if (options.command === 'backup') {
      const outputDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../backups');
      const destination = path.resolve(options.destination || path.join(outputDirectory, `${database}-${new Date().toISOString().replace(/[:.]/g, '-')}.seabak`));
      await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      try {
        const output = await writeEncryptedSnapshot({ connection, database, destination, key });
        await connection.commit();
        console.log(`Encrypted snapshot created: ${output}`);
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    } else {
      const result = await restoreEncryptedSnapshot({
        connection,
        source: options.source,
        key,
        database,
        replace: options.replace
      });
      console.log(`Restore completed for ${result.database}: ${result.tables} tables, ${result.rows} rows.`);
    }
  } finally {
    try {
      if (locked) await connection.query('SELECT RELEASE_LOCK(?)', [lockName]);
    } finally {
      await connection.end();
    }
  }
}
