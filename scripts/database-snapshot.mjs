import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, open, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const PROJECT = 'southeast-asian-student-service-platform';
const MAGIC = Buffer.from('SEAPG001');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_METADATA_BYTES = 4096;
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

export function parseEncryptionKey(value) {
  if (!/^[\da-f]{64}$/i.test(String(value || ''))) {
    throw new Error('DB_BACKUP_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters.');
  }
  return Buffer.from(value, 'hex');
}

export function validateDatabaseName(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/i.test(String(value || ''))) {
    throw new Error('PostgreSQL database name is not a safe identifier.');
  }
  return value;
}

export function assertSafeRestoreTarget({ targetDatabase, sourceDatabase, replace }) {
  validateDatabaseName(targetDatabase);
  validateDatabaseName(sourceDatabase);
  if (targetDatabase === sourceDatabase) throw new Error('Restore target must differ from the source database.');
  if (!targetDatabase.toLowerCase().endsWith('_test')) throw new Error('Restore target must end in _test.');
  if (replace !== true) throw new Error('Restore requires explicit --replace confirmation.');
}

function parseArgs(argv) {
  const [action, ...rest] = argv;
  const options = { replace: false };
  if (!['backup', 'restore'].includes(action)) return null;
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (item === '--replace') options.replace = true;
    else if (item === '--help' || item === '-h') options.help = true;
    else if (item.startsWith('--')) {
      const value = rest[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${item}.`);
      options[item.slice(2)] = value;
      index += 1;
    } else throw new Error(`Unknown argument: ${item}.`);
  }
  return { action, options };
}

function dbEnvironment(database = process.env.PGDATABASE) {
  const host = process.env.PGHOST || '127.0.0.1';
  const port = String(process.env.PGPORT || 5432);
  const user = process.env.PGUSER || 'international_student_platform_app';
  const password = process.env.PGPASSWORD;
  if (!password) throw new Error('PGPASSWORD is not set.');
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('PGPORT is invalid.');
  return {
    ...process.env,
    PGHOST: host,
    PGPORT: port,
    PGUSER: user,
    PGPASSWORD: password,
    PGDATABASE: validateDatabaseName(database),
    PGSSLMODE: process.env.PGSSL === '1' ? 'require' : 'prefer'
  };
}

function runTool(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', (error) => reject(new Error(`${path.basename(command)} could not start: ${error.message}`)));
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`${path.basename(command)} failed with exit code ${code}${stderr ? `: ${stderr.trim()}` : ''}`)));
  });
}

function makeHeader(metadata, iv) {
  const metadataBytes = Buffer.from(JSON.stringify(metadata));
  if (metadataBytes.length > MAX_METADATA_BYTES) throw new Error('Backup metadata is too large.');
  const header = Buffer.alloc(MAGIC.length + 4 + metadataBytes.length + IV_BYTES + TAG_BYTES);
  MAGIC.copy(header);
  header.writeUInt32BE(metadataBytes.length, MAGIC.length);
  metadataBytes.copy(header, MAGIC.length + 4);
  iv.copy(header, MAGIC.length + 4 + metadataBytes.length);
  return { header, metadataBytes, tagOffset: header.length - TAG_BYTES };
}

export async function encryptArchive(archivePath, destination, metadata, key) {
  const iv = randomBytes(IV_BYTES);
  const { header, metadataBytes, tagOffset } = makeHeader(metadata, iv);
  const partial = `${destination}.${process.pid}.${randomBytes(6).toString('hex')}.partial`;
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.concat([MAGIC, metadataBytes]));
  try {
    await writeFile(partial, header, { flag: 'wx', mode: 0o600 });
    await pipeline(createReadStream(archivePath), cipher, createWriteStream(partial, { flags: 'a', mode: 0o600 }));
    const file = await open(partial, 'r+');
    try { await file.write(cipher.getAuthTag(), 0, TAG_BYTES, tagOffset); await file.sync(); }
    finally { await file.close(); }
    await link(partial, destination);
  } finally {
    await unlink(partial).catch(() => {});
  }
}

export async function decryptArchive(source, directory, key) {
  const handle = await open(source, 'r');
  let metadata;
  let metadataBytes;
  let iv;
  let tag;
  let offset;
  try {
    const fixed = Buffer.alloc(MAGIC.length + 4);
    const fixedRead = await handle.read(fixed, 0, fixed.length, 0);
    if (fixedRead.bytesRead !== fixed.length || !fixed.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('Unsupported or invalid PostgreSQL backup format.');
    }
    const metadataLength = fixed.readUInt32BE(MAGIC.length);
    if (metadataLength < 2 || metadataLength > MAX_METADATA_BYTES) throw new Error('Invalid backup metadata length.');
    metadataBytes = Buffer.alloc(metadataLength);
    iv = Buffer.alloc(IV_BYTES);
    tag = Buffer.alloc(TAG_BYTES);
    offset = fixed.length;
    for (const [buffer, size] of [[metadataBytes, metadataLength], [iv, IV_BYTES], [tag, TAG_BYTES]]) {
      const part = await handle.read(buffer, 0, size, offset);
      if (part.bytesRead !== size) throw new Error('Backup file is truncated.');
      offset += size;
    }
    try { metadata = JSON.parse(metadataBytes.toString('utf8')); }
    catch { throw new Error('Invalid PostgreSQL backup metadata.'); }
  } finally {
    await handle.close();
  }
  if (metadata?.format !== 1 || metadata?.project !== PROJECT) throw new Error('Backup belongs to another project or uses an unsupported version.');
  validateDatabaseName(metadata.database);

  const archivePath = path.join(directory, 'restore.dump');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.concat([MAGIC, metadataBytes]));
  decipher.setAuthTag(tag);
  try {
    await pipeline(createReadStream(source, { start: offset }), decipher, createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }));
  } catch (error) {
    if (/authenticate data|bad decrypt/i.test(error.message)) throw new Error('Backup authentication failed; restore was not started.');
    throw error;
  }
  return { archivePath, metadata };
}

export async function backupDatabase({ destination, database, key, env = process.env }) {
  const target = path.resolve(destination);
  await mkdir(path.dirname(target), { recursive: true });
  const directory = await mkdtemp(path.join(os.tmpdir(), `${PROJECT}-backup-`));
  await chmod(directory, 0o700).catch(() => {});
  const archivePath = path.join(directory, 'database.dump');
  try {
    await runTool('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--lock-wait-timeout=10000', '--file', archivePath], dbEnvironment(database));
    const metadata = { format: 1, project: PROJECT, database, createdAt: new Date().toISOString() };
    await encryptArchive(archivePath, target, metadata, key);
    return target;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function restoreDatabase({ source, targetDatabase, sourceDatabase, replace, key, env = process.env }) {
  assertSafeRestoreTarget({ targetDatabase, sourceDatabase, replace });
  const directory = await mkdtemp(path.join(os.tmpdir(), `${PROJECT}-restore-`));
  await chmod(directory, 0o700).catch(() => {});
  try {
    const { archivePath, metadata } = await decryptArchive(path.resolve(source), directory, key);
    if (metadata.database !== sourceDatabase) throw new Error('Backup database does not match PGDATABASE.');
    await runTool('pg_restore', [
      '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', '--clean', '--if-exists',
      `--dbname=${validateDatabaseName(targetDatabase)}`, archivePath
    ], dbEnvironment(targetDatabase));
    return { database: targetDatabase, sourceDatabase, project: metadata.project };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function usage() {
  console.log('Usage: node scripts/database-snapshot.mjs backup [--destination <file>]');
  console.log('       node scripts/database-snapshot.mjs restore --source <file> --target <different_name_test> --replace');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (!parsed || parsed.options.help) { usage(); process.exitCode = parsed ? 0 : 2; }
    else {
      const database = validateDatabaseName(process.env.PGDATABASE || 'international_student_platform');
      const key = parseEncryptionKey(process.env.DB_BACKUP_ENCRYPTION_KEY);
      if (parsed.action === 'backup') {
        const output = parsed.options.destination || path.resolve('backups', `${database}-${new Date().toISOString().replace(/[:.]/g, '-')}.seapg`);
        const result = await backupDatabase({ destination: output, database, key });
        console.log(`Encrypted PostgreSQL backup created: ${result}`);
      } else {
        if (!parsed.options.source || !parsed.options.target) throw new Error('Restore requires --source and --target.');
        const result = await restoreDatabase({
          source: parsed.options.source,
          targetDatabase: parsed.options.target,
          sourceDatabase: database,
          replace: parsed.options.replace,
          key
        });
        console.log(`Restore completed for isolated database ${result.database}.`);
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
