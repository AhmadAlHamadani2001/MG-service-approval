// CLI helper: `npm run seed:reset` wipes the current data (local data.json,
// or the Postgres table when DATABASE_URL is set) back to the original demo
// seed (fresh users, catalog, and example requests).
require('dotenv').config({ quiet: true }); // see server/index.js for why
const { init, resetToSeed, DATA_FILE, USE_POSTGRES } = require('./db');
const vehiclesStore = require('./vehiclesStore');

(async () => {
  await init();
  await vehiclesStore.init();
  const { seedVehicles } = await resetToSeed();
  if (seedVehicles) await vehiclesStore.resetToSeed(seedVehicles);
  console.log(USE_POSTGRES
    ? 'Reset complete. Demo data restored in the Postgres database.'
    : `Reset complete. Demo data restored at ${DATA_FILE}`);
  process.exit(0);
})().catch(err => {
  console.error('Reset failed:', err);
  process.exit(1);
});
