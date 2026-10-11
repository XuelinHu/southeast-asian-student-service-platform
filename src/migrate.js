const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config();

const { BUILTIN_ROLES, expandRoleMenus } = require('./config/roles');
const { menuOrder } = require('./config/resources');
const { withMigrationLock } = require('./services/migrationLock');

const database = process.env.PGDATABASE || 'international_student_platform';
const dryRun = process.env.MIGRATE_DRY_RUN === '1';
const schemaPath = path.join(__dirname, '..', 'database', 'postgres', 'schema.sql');
const seedPath = path.join(__dirname, '..', 'database', 'postgres', 'seed.sql');
const migrationsPath = path.join(__dirname, '..', 'database', 'postgres', 'migrations');

function migrationChecksum(schema, seed) {
  return crypto.createHash('sha256')
    .update(schema)
    .update('\n-- seed --\n')
    .update(seed)
    .update('\n-- role definitions --\n')
    .update(JSON.stringify(BUILTIN_ROLES))
    .update(JSON.stringify(menuOrder))
    .digest('hex');
}

async function seedRoleMenus(client) {
  for (const role of BUILTIN_ROLES) {
    const result = await client.query(
      `INSERT INTO roles (code, name, scope, data_scope, is_super, is_builtin, sort_order, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order
       RETURNING id`,
      [role.code, role.name, role.scope, role.dataScope, role.isSuper ? 1 : 0, role.isBuiltin ? 1 : 0, role.sortOrder, role.description || '']
    );
    const roleId = result.rows[0].id;
    for (const grant of expandRoleMenus(role, menuOrder)) {
      await client.query(
        `INSERT INTO role_menus (role_id, menu_key, can_view, can_create, can_update, can_delete, teacher_types)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (role_id, menu_key) DO NOTHING`,
        [roleId, grant.menuKey, grant.canView, grant.canCreate, grant.canUpdate, grant.canDelete, grant.teacherTypes]
      );
    }
  }
}

async function resetSeedSequences(client) {
  for (const table of ['roles', 'nationalities', 'external_schools', 'grade_rules']) {
    await client.query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${table}), 1), 1), EXISTS (SELECT 1 FROM ${table}))`,
      [`public.${table}`]
    );
  }
}

async function getMigrations() {
  const schema = fs.readFileSync(schemaPath, 'utf8');
  const seed = fs.readFileSync(seedPath, 'utf8');
  const migrations = [{
    version: '001_initial_schema',
    checksum: migrationChecksum(schema, seed),
    async up(client) {
      await client.query(schema);
      await client.query(seed);
      await seedRoleMenus(client);
      await resetSeedSequences(client);
    }
  }];
  for (const file of fs.readdirSync(migrationsPath).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(migrationsPath, file), 'utf8');
    migrations.push({
      version: file.replace(/\.sql$/i, ''),
      checksum: crypto.createHash('sha256').update(sql).digest('hex'),
      async up(client) { await client.query(sql); }
    });
  }
  return migrations;
}

async function migrate() {
  const migrations = await getMigrations();
  if (dryRun) {
    for (const migration of migrations) console.log(`[dry-run] would run ${migration.version}`);
    return { applied: [], skipped: [], dryRun: true };
  }

  if (!process.env.PGPASSWORD) throw new Error('PGPASSWORD must be set in the local environment.');
  const pool = require('./config/db');
  const client = await pool.connect();
  try {
    return await withMigrationLock(client, database, async () => {
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      const result = { applied: [], skipped: [], dryRun: false };
      for (const migration of migrations) {
        const recorded = await client.query('SELECT checksum FROM schema_migrations WHERE version = $1', [migration.version]);
        if (recorded.rowCount) {
          if (recorded.rows[0].checksum !== migration.checksum) {
            throw new Error(`Applied migration was modified: ${migration.version}`);
          }
          result.skipped.push(migration.version);
          console.log(`[skip] ${migration.version}`);
          continue;
        }

        await client.query('BEGIN');
        try {
          await migration.up(client);
          await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [migration.version, migration.checksum]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
        result.applied.push(migration.version);
        console.log(`[apply] ${migration.version}`);
      }
      return result;
    });
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  migrate().catch(async (error) => {
    console.error(`\nMigration failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { migrate, migrationChecksum, seedRoleMenus, getMigrations };
