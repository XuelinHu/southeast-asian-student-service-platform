const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

async function initDb() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'Java@c1024',
    multipleStatements: true
  });

  await connection.query(sql);
  await connection.end();
  console.log('Database initialized.');
}

initDb().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
