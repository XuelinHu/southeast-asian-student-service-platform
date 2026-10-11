require('dotenv').config();
const { migrate } = require('./migrate');

async function initDb() {
  return migrate();
}

if (require.main === module) {
  initDb().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { initDb };
