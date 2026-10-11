const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

if (!process.env.DB_PASSWORD) {
  throw new Error('DB_PASSWORD must be set in the local environment.');
}

function schemaForDatabase(schema, database) {
  if (!/^[A-Za-z0-9_]+$/.test(database)) {
    throw new Error('DB_NAME must contain only ASCII letters, digits, and underscores.');
  }
  return schema.replaceAll('international_student_platform', database);
}

async function initDb() {
  const database = process.env.DB_NAME || 'international_student_platform';
  const schema = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
  const sql = schemaForDatabase(schema, database);
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    multipleStatements: true
  });

  await connection.query(sql);
  await connection.end();
  console.log('Database initialized.');
}

if (require.main === module) {
  initDb().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { initDb, schemaForDatabase };
