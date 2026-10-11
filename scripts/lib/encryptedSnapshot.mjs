import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createGunzip, createGzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('SEABK001');
const APPLICATION = 'southeast-asian-student-service-platform';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES;
const PAGE_SIZE = 250;
const MAX_LINE_BYTES = 16 * 1024 * 1024;

export function parseEncryptionKey(value) {
  if (typeof value !== 'string' || !/^[a-f\d]{64}$/i.test(value)) {
    throw new Error('DB_BACKUP_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters.');
  }
  return Buffer.from(value, 'hex');
}

export function assertSafeRestoreTarget({ database, replace }) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(String(database || ''))) throw new Error('Restore target database name is invalid.');
  if (!String(database).toLowerCase().endsWith('_test')) throw new Error('Restore is restricted to a DB_NAME ending in _test.');
  if (replace !== true) throw new Error('Restore requires explicit confirmation with --replace.');
}

export function encodeCell(value) {
  return Buffer.isBuffer(value) ? { $sbrBinary: value.toString('base64') } : value;
}

export function decodeCell(value, type) {
  const normalizedType = String(type).toLowerCase();
  if (value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.$sbrBinary === 'string'
    && /(binary|blob|bit)/.test(normalizedType)) {
    return Buffer.from(value.$sbrBinary, 'base64');
  }
  if (/^json\b/.test(normalizedType) && value !== null && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

export function normalizeCreateSql(value) {
  return String(value).replace(/\sAUTO_INCREMENT=\d+/gi, '').trim();
}

export function getSchemaFingerprint(tables) {
  const schema = [...tables]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map(({ name, createSql, columns }) => ({
      name,
      createSql: normalizeCreateSql(createSql),
      columns: columns.map(({ name: columnName, type, generated }) => ({
        name: columnName,
        type: String(type).toLowerCase(),
        generated: Boolean(generated)
      }))
    }));
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex');
}

function quoteIdentifier(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

async function getSchema(connection) {
  const [objects] = await connection.query(
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, AUTO_INCREMENT AS autoIncrement
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY TABLE_NAME`
  );
  const unsupported = objects.filter((object) => object.type !== 'BASE TABLE');
  if (unsupported.length) {
    throw new Error(`Backup refuses unsupported database objects: ${unsupported.map((item) => item.name).join(', ')}`);
  }

  const [extraObjects] = await connection.query(
    `SELECT 'trigger' AS kind, TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()
     UNION ALL
     SELECT 'routine' AS kind, ROUTINE_NAME AS name FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()
     UNION ALL
     SELECT 'event' AS kind, EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE()`
  );
  if (extraObjects.length) {
    throw new Error(`Backup refuses database triggers/routines/events: ${extraObjects.map((item) => `${item.kind}:${item.name}`).join(', ')}`);
  }

  const tables = [];
  for (const object of objects) {
    if (object.engine !== 'InnoDB') throw new Error(`Backup requires InnoDB; ${object.name} uses ${object.engine || 'no engine'}.`);
    const tableName = String(object.name);
    const [createRows] = await connection.query(`SHOW CREATE TABLE ${quoteIdentifier(tableName)}`);
    const createSql = createRows[0]?.['Create Table'];
    if (!createSql) throw new Error(`Could not read table definition for ${tableName}.`);
    const [columnRows] = await connection.query(`SHOW COLUMNS FROM ${quoteIdentifier(tableName)}`);
    const columns = columnRows.map((column) => ({
      name: column.Field,
      type: column.Type,
      generated: /(VIRTUAL|STORED) GENERATED/i.test(column.Extra || ''),
      primary: column.Key === 'PRI'
    }));
    if (!columns.some((column) => column.primary)) throw new Error(`Backup requires a primary key on ${tableName}.`);
    tables.push({
      name: tableName,
      createSql,
      autoIncrement: object.autoIncrement === null || object.autoIncrement === undefined
        ? null
        : String(object.autoIncrement),
      columns
    });
  }
  return tables;
}

function getPrimaryColumns(table) {
  return table.columns.filter((column) => column.primary).map((column) => column.name);
}

async function* snapshotRecords(connection, tables, database) {
  const manifestTables = [];
  for (const table of tables) {
    const [countRows] = await connection.query(`SELECT COUNT(*) AS row_count FROM ${quoteIdentifier(table.name)}`);
    manifestTables.push({ ...table, rowCount: Number(countRows[0].row_count) });
  }
  const manifest = {
    kind: 'manifest',
    format: 1,
    application: APPLICATION,
    database,
    createdAt: new Date().toISOString(),
    tables: manifestTables,
    schemaFingerprint: getSchemaFingerprint(manifestTables)
  };
  yield `${JSON.stringify(manifest)}\n`;

  for (const table of manifestTables) {
    const primaryColumns = getPrimaryColumns(table);
    const writableColumns = table.columns.filter((column) => !column.generated);
    const selectedColumns = writableColumns.map((column) => quoteIdentifier(column.name)).join(', ');
    const ordering = primaryColumns.map(quoteIdentifier).join(', ');
    const predicates = primaryColumns.map((_, index) => {
      const equalPrefix = primaryColumns.slice(0, index).map((column) => `${quoteIdentifier(column)} = ?`);
      return `(${[...equalPrefix, `${quoteIdentifier(primaryColumns[index])} > ?`].join(' AND ')})`;
    });
    let cursor = null;
    while (true) {
      const where = cursor ? ` WHERE ${predicates.join(' OR ')}` : '';
      const cursorValues = cursor
        ? predicates.flatMap((_, index) => [...cursor.slice(0, index), cursor[index]])
        : [];
      const [rows] = await connection.query(
        `SELECT ${selectedColumns} FROM ${quoteIdentifier(table.name)}${where} ORDER BY ${ordering} LIMIT ${PAGE_SIZE}`,
        cursorValues
      );
      if (!rows.length) break;
      for (const row of rows) {
        const values = writableColumns.map((column) => encodeCell(row[column.name]));
        yield `${JSON.stringify({ table: table.name, values })}\n`;
      }
      cursor = primaryColumns.map((column) => rows.at(-1)[column]);
    }
  }
}

export async function writeEncryptedSnapshot({ connection, database, destination, key }) {
  const encryptionKey = Buffer.isBuffer(key) ? key : parseEncryptionKey(key);
  const outputPath = path.resolve(destination);
  const partialPath = `${outputPath}.${process.pid}.${randomBytes(6).toString('hex')}.partial`;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  let partialCreated = false;

  try {
    await mkdir(path.dirname(outputPath), { recursive: true });
    const handle = await open(partialPath, 'wx', 0o600);
    partialCreated = true;
    await handle.write(Buffer.concat([MAGIC, iv]));
    await handle.close();

    await pipeline(
      (async function* () {
        yield* snapshotRecords(connection, await getSchema(connection), database);
      })(),
      createGzip({ level: 6 }),
      cipher,
      createWriteStream(partialPath, { flags: 'a' })
    );
    await appendFileBytes(partialPath, cipher.getAuthTag());
    await link(partialPath, outputPath);
    await unlink(partialPath);
    partialCreated = false;
    return outputPath;
  } finally {
    if (partialCreated) await unlink(partialPath).catch(() => {});
  }
}

async function appendFileBytes(filePath, bytes) {
  const handle = await open(filePath, 'a');
  try {
    await handle.write(bytes);
  } finally {
    await handle.close();
  }
}

async function* decryptedLines(source, key) {
  const stat = await lstat(source);
  if (!stat.isFile() || stat.size <= HEADER_BYTES + TAG_BYTES) throw new Error('Snapshot file is missing or too small.');
  const headerHandle = await open(source, 'r');
  const header = Buffer.alloc(HEADER_BYTES);
  try {
    const { bytesRead } = await headerHandle.read(header, 0, HEADER_BYTES, 0);
    if (bytesRead !== HEADER_BYTES) throw new Error('Snapshot header is truncated.');
  } finally {
    await headerHandle.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Snapshot format is not recognized.');
  const iv = header.subarray(MAGIC.length);
  const footerHandle = await open(source, 'r');
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    await footerHandle.read(tag, 0, TAG_BYTES, stat.size - TAG_BYTES);
  } finally {
    await footerHandle.close();
  }
  const decipher = createDecipheriv('aes-256-gcm', Buffer.isBuffer(key) ? key : parseEncryptionKey(key), iv);
  decipher.setAuthTag(tag);
  const gunzip = createGunzip();
  const lines = createInterface({ input: gunzip, crlfDelay: Infinity });
  const completion = pipeline(
    createReadStream(source, { start: HEADER_BYTES, end: stat.size - TAG_BYTES - 1 }),
    decipher,
    gunzip
  );
  try {
    for await (const line of lines) {
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw new Error('Snapshot record exceeds the maximum supported size.');
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error('Snapshot contains malformed JSON.');
      }
      yield record;
    }
    await completion;
  } catch (error) {
    lines.close();
    gunzip.destroy();
    await completion.catch(() => {});
    throw error;
  }
}

async function scanSnapshot(source, key, onRecord = async () => {}) {
  let manifest = null;
  const counts = new Map();
  for await (const record of decryptedLines(source, key)) {
    if (!manifest) {
      if (record.kind !== 'manifest' || record.format !== 1 || record.application !== APPLICATION || !Array.isArray(record.tables)) {
        throw new Error('Snapshot manifest is invalid or unsupported.');
      }
      for (const table of record.tables) {
        if (table.autoIncrement !== null && !/^\d+$/.test(String(table.autoIncrement))) {
          throw new Error(`Snapshot contains an invalid auto increment value for ${table.name}.`);
        }
      }
      if (getSchemaFingerprint(record.tables) !== record.schemaFingerprint) throw new Error('Snapshot schema fingerprint is invalid.');
      manifest = record;
      for (const table of manifest.tables) counts.set(table.name, 0);
      await onRecord(record, null);
      continue;
    }
    if (!record || typeof record.table !== 'string' || !Array.isArray(record.values) || !counts.has(record.table)) {
      throw new Error('Snapshot contains an invalid table record.');
    }
    const table = manifest.tables.find((item) => item.name === record.table);
    const writableColumns = table.columns.filter((column) => !column.generated);
    if (record.values.length !== writableColumns.length) throw new Error(`Snapshot row shape does not match ${record.table}.`);
    counts.set(record.table, counts.get(record.table) + 1);
    await onRecord(record, table);
  }
  if (!manifest) throw new Error('Snapshot is empty.');
  for (const table of manifest.tables) {
    if (counts.get(table.name) !== table.rowCount) throw new Error(`Snapshot row count mismatch for ${table.name}.`);
  }
  return manifest;
}

export async function validateEncryptedSnapshot({ source, key }) {
  return scanSnapshot(source, key);
}

export async function restoreEncryptedSnapshot({ connection, source, key, database, replace = false }) {
  assertSafeRestoreTarget({ database, replace });
  const liveSchema = await getSchema(connection);
  const manifest = await validateEncryptedSnapshot({ source, key });
  if (getSchemaFingerprint(liveSchema) !== manifest.schemaFingerprint) {
    throw new Error('Target database schema does not match the snapshot; initialize the target with the matching project migrations first.');
  }

  await connection.query('SET FOREIGN_KEY_CHECKS = 0');
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    for (const table of manifest.tables) await connection.query(`DELETE FROM ${quoteIdentifier(table.name)}`);

    await scanSnapshot(source, key, async (record, table) => {
      if (!table) return;
      const columns = table.columns.filter((column) => !column.generated);
      if (!columns.length) return;
      const columnNames = columns.map((column) => quoteIdentifier(column.name)).join(', ');
      const placeholders = `(${columns.map(() => '?').join(', ')})`;
      const values = record.values.map((value, index) => decodeCell(value, columns[index].type));
      await connection.query(`INSERT INTO ${quoteIdentifier(table.name)} (${columnNames}) VALUES ${placeholders}`, values);
    });

    for (const table of manifest.tables) {
      const [rows] = await connection.query(`SELECT COUNT(*) AS row_count FROM ${quoteIdentifier(table.name)}`);
      if (Number(rows[0].row_count) !== table.rowCount) throw new Error(`Restored row count mismatch for ${table.name}.`);
    }
    await connection.commit();
    transactionStarted = false;
    for (const table of manifest.tables) {
      if (table.autoIncrement !== null && table.autoIncrement !== undefined) {
        await connection.query(`ALTER TABLE ${quoteIdentifier(table.name)} AUTO_INCREMENT = ${table.autoIncrement}`);
      }
    }
  } catch (error) {
    if (transactionStarted) await connection.rollback();
    throw error;
  } finally {
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
  }
  return { database, tables: manifest.tables.length, rows: manifest.tables.reduce((sum, table) => sum + table.rowCount, 0) };
}
