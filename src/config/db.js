const { Pool, types } = require('pg');
require('dotenv').config();

types.setTypeParser(20, (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
});

const database = process.env.PGDATABASE || 'international_student_platform';
if (!/^[a-z][a-z0-9_]{0,62}$/i.test(database)) {
  throw new Error('PGDATABASE must be a valid PostgreSQL database identifier.');
}

const idTables = new Set([
  'roles', 'role_menus', 'users', 'nationalities', 'teachers', 'classes', 'students', 'dormitories',
  'visas', 'study_records', 'external_schools', 'grade_rules', 'grade_records', 'login_logs', 'agent_messages'
]);

function bindParameters(sql, params = []) {
  const values = [];
  const named = !Array.isArray(params);
  const names = new Map();
  let text = '';
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let positional = 0;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      text += char;
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      text += char;
      if (char === '*' && next === '/') { text += next; index += 1; blockComment = false; }
      continue;
    }
    if (quote) {
      text += quote === '`' && char === '`' ? '"' : char;
      if (char === quote && next === quote) { text += next; index += 1; }
      else if (char === quote && sql[index - 1] !== '\\') quote = null;
      continue;
    }
    if ((char === '-' && next === '-') || (char === '/' && next === '*')) {
      text += char + next;
      index += 1;
      if (char === '-') lineComment = true;
      else blockComment = true;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      text += char === '`' ? '"' : char;
      continue;
    }
    if (!named && char === '?') {
      positional += 1;
      values.push(params[positional - 1] ?? null);
      text += `$${values.length}`;
      continue;
    }
    if (named && char === ':' && next !== ':' && sql[index - 1] !== ':' && /[A-Za-z_]/.test(next || '')) {
      const match = sql.slice(index + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      const name = match[0];
      if (!Object.hasOwn(params, name)) throw new Error(`Missing SQL parameter: ${name}`);
      if (!names.has(name)) { values.push(params[name] ?? null); names.set(name, values.length); }
      text += `$${names.get(name)}`;
      index += name.length;
      continue;
    }
    text += char;
  }
  if (!named && positional !== params.length) throw new Error('SQL parameter count does not match placeholders.');
  return { text, values };
}

function prepare(sql, params) {
  const insert = sql.match(/^\s*INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)/i);
  const statement = insert && idTables.has(insert[1]) && !/\bRETURNING\b/i.test(sql)
    ? `${sql.trim().replace(/;$/, '')} RETURNING id`
    : sql;
  return bindParameters(statement, params);
}

async function queryOn(client, sql, params = []) {
  const { text, values } = prepare(sql, params);
  const result = values.length ? await client.query(text, values) : await client.query(text);
  const rows = result.rows || [];
  const metadata = { affectedRows: result.rowCount || 0, rowCount: result.rowCount || 0, insertId: rows[0]?.id };
  Object.defineProperties(rows, {
    affectedRows: { value: metadata.affectedRows },
    rowCount: { value: metadata.rowCount },
    insertId: { value: metadata.insertId }
  });
  return [rows, metadata];
}

const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'international_student_platform_app',
  password: process.env.PGPASSWORD || '',
  database,
  max: Math.min(50, Math.max(1, Number(process.env.PGPOOL_MAX || 10))),
  ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: true } : undefined,
  application_name: 'southeast-asian-student-service-platform'
});

const rawQuery = pool.query.bind(pool);
pool.query = (sql, params = []) => queryOn({ query: rawQuery }, sql, params);
pool.execute = pool.query;
const connect = pool.connect.bind(pool);
pool.getConnection = async () => {
  const client = await connect();
  return {
    query: (sql, params = []) => queryOn(client, sql, params),
    execute: (sql, params = []) => queryOn(client, sql, params),
    beginTransaction: () => client.query('BEGIN'),
    commit: () => client.query('COMMIT'),
    rollback: () => client.query('ROLLBACK'),
    release: () => client.release()
  };
};

module.exports = pool;
module.exports.bindParameters = bindParameters;
