const crypto = require('crypto');

function migrationChecksum(migration) {
  return crypto.createHash('sha256')
    .update(`${migration.name}\n${migration.up.toString()}`)
    .digest('hex');
}

async function runMigrationsWithLedger(conn, db, migrations, { dryRun = false } = {}) {
  const names = migrations.map((migration) => migration.name);
  if (names.some((name) => !name) || new Set(names).size !== names.length) {
    throw new Error('Migration names must be non-empty and unique.');
  }

  if (dryRun) {
    for (const migration of migrations) console.log(`[dry-run] would run ${migration.name}`);
    return { applied: [], skipped: [], dryRun: true };
  }

  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(128) PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const result = { applied: [], skipped: [], dryRun: false };
  for (const migration of migrations) {
    const checksum = migrationChecksum(migration);
    const [rows] = await conn.query(
      'SELECT checksum FROM schema_migrations WHERE version = ?',
      [migration.name]
    );
    const recordedChecksum = rows[0]?.checksum;

    if (recordedChecksum) {
      if (recordedChecksum !== checksum) {
        throw new Error(`Applied migration was modified: ${migration.name}`);
      }
      result.skipped.push(migration.name);
      console.log(`[skip] migration ${migration.name}`);
      continue;
    }

    await migration.up(conn, db);
    await conn.query(
      'INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)',
      [migration.name, checksum]
    );
    result.applied.push(migration.name);
  }

  return result;
}

module.exports = { migrationChecksum, runMigrationsWithLedger };
