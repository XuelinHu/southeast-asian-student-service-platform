function getDemoSeedOptions(env = process.env, args = process.argv.slice(2)) {
  if (env.NODE_ENV === 'production') {
    throw new Error('Demo data seeding is disabled in production.');
  }
  if (env.ALLOW_DEMO_SEED !== '1') {
    throw new Error('Set ALLOW_DEMO_SEED=1 to explicitly enable demo data seeding.');
  }

  const database = String(env.DB_NAME || 'international_student_platform');
  if (!/(?:_dev|_test|_demo)$/i.test(database) || env.DEMO_SEED_DATABASE !== database) {
    throw new Error('Demo seed requires a database ending in _dev, _test, or _demo and an exact DEMO_SEED_DATABASE match.');
  }

  const password = String(env.DEMO_SEED_PASSWORD || '');
  if (
    password.length < 16 ||
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/[0-9]/.test(password) ||
    !/[^A-Za-z0-9]/.test(password)
  ) {
    throw new Error('DEMO_SEED_PASSWORD must be at least 16 characters and include lower/upper case, a number, and a symbol.');
  }

  return { database, password, resetDemoPasswords: args.includes('--reset-demo-passwords') };
}

function demoUserDuplicateUpdate(resetDemoPasswords) {
  if (!resetDemoPasswords) {
    return 'id = id, username = username, password_hash = password_hash, role_id = role_id, display_name = display_name, status = status';
  }
  return 'password_hash = IF(id = VALUES(id), VALUES(password_hash), password_hash), role_id = role_id, display_name = display_name, status = status';
}

module.exports = { getDemoSeedOptions, demoUserDuplicateUpdate };
