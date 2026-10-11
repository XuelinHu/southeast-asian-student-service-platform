const crypto = require('node:crypto');

function migrationLockName(database) {
  const digest = crypto.createHash('sha256').update(String(database)).digest('hex').slice(0, 32);
  return `student-platform:migrate:${digest}`;
}

async function withMigrationLock(connection, database, migrate) {
  const lockName = migrationLockName(database);
  await connection.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockName]);
  try {
    return await migrate();
  } finally {
    await connection.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockName]);
  }
}

module.exports = { migrationLockName, withMigrationLock };
