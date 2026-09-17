// CLI helper: `npm run seed:reset` wipes the current data (local data.json,
// or the Postgres table when DATABASE_URL is set) back to the original demo
// seed (fresh users, catalog, and example requests).
require('dotenv').config();
const { init, resetToSeed, DATA_FILE, USE_POSTGRES } = require('./db');

(async () => {
  await init();
  await resetToSeed();
  console.log(USE_POSTGRES
    ? 'Reset complete. Demo data restored in the Postgres database.'
    : `Reset complete. Demo data restored at ${DATA_FILE}`);
  process.exit(0);
})().catch(err => {
  console.error('Reset failed:', err);
  process.exit(1);
});
