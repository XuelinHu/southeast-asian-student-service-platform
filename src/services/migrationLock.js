const crypto = require('crypto');

function migrationLockName(database) {
  const digest = crypto.createHash('sha256').update(database).digest('hex').slice(0, 24);
  return `student-platform-migrate:${digest}`;
}

async function withMigrationLock(connection, database, migrate) {
  const lockName = migrationLockName(database);
  const [[lock]] = await connection.query('SELECT GET_LOCK(?, 15) AS acquired', [lockName]);
  if (Number(lock.acquired) !== 1) throw new Error('Could not acquire the database migration lock.');

  try {
    return await migrate();
  } finally {
    await connection.query('SELECT RELEASE_LOCK(?)', [lockName]);
  }
}

module.exports = { migrationLockName, withMigrationLock };
