// Storage for vehicle master data (VIN / ATA / purchase date / warranty
// start date) — split out from db.js's single JSONB-blob storage because
// this table is meant to hold a full dealer-management-system export
// (realistically 100,000+ rows). Keeping that many rows inside the one
// in-memory "whole app state" blob that db.js reads/writes as a unit meant
// every single write anywhere in the app — even an unrelated password
// change — re-serialized the entire vehicle table to JSON and rewrote it to
// Postgres, and the whole table sat in process memory at all times. That is
// what was actually crashing the server under real import volumes, not
// host RAM limits.
//
// Two backends, mirroring db.js's own split:
//   - DATABASE_URL set (production): vehicles live in their own real
//     Postgres table, queried/written a page or a batch at a time — never
//     loaded whole into memory, never re-serialized as one JSON blob.
//   - No DATABASE_URL (local dev): vehicles stay exactly as before, as the
//     db.vehicles array inside db.js's single JSON file. Local/demo data is
//     always small (a handful of seed vehicles), so the simpler shared
//     design is fine there and keeps `npm start` with zero setup unchanged.
//
// Every function below picks its backend internally, so server/routes/
// vehicles.js calls one interface regardless of which mode is active.

const { db, persist, USE_POSTGRES, pgPool } = require('./db');

const TABLE = 'vehicles';
// Chunk size for multi-row INSERTs (bulk import and the one-time legacy
// migration below). Large enough to keep round-trips down, small enough
// that one statement's parameter list and payload stay modest.
const INSERT_CHUNK_SIZE = 2000;

function rowToVehicle(row) {
  return {
    id: row.id,
    vin: row.vin,
    ata: row.ata,
    purchaseDate: row.purchase_date,
    warrantyStartDate: row.warranty_start_date,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---- Postgres backend -------------------------------------------------

async function pgEnsureTable() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      vin TEXT NOT NULL UNIQUE,
      ata TEXT,
      purchase_date TEXT,
      warranty_start_date TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

// Inserts a batch of already-built vehicle objects, chunked, using
// ON CONFLICT DO NOTHING so it's always safe to call even if some VINs
// already exist (used by both real bulk-import and the legacy migration
// below). Returns the number of rows actually inserted.
async function pgBulkInsert(vehicles) {
  let insertedCount = 0;
  for (const part of chunk(vehicles, INSERT_CHUNK_SIZE)) {
    if (!part.length) continue;
    const cols = ['id', 'vin', 'ata', 'purchase_date', 'warranty_start_date', 'created_by', 'created_at', 'updated_at'];
    const values = [];
    const placeholders = part.map((v, i) => {
      const base = i * cols.length;
      values.push(v.id, v.vin, v.ata, v.purchaseDate, v.warrantyStartDate, v.createdBy, v.createdAt, v.updatedAt);
      return `(${cols.map((_, j) => `$${base + j + 1}`).join(', ')})`;
    });
    const res = await pgPool.query(
      `INSERT INTO ${TABLE} (${cols.join(', ')}) VALUES ${placeholders.join(', ')} ON CONFLICT (vin) DO NOTHING RETURNING vin`,
      values
    );
    insertedCount += res.rowCount;
  }
  return insertedCount;
}

async function pgList({ search, page, pageSize }) {
  const params = [];
  let where = '';
  if (search) {
    params.push(`%${search}%`);
    where = `WHERE vin LIKE $${params.length}`;
  }
  const totalRes = await pgPool.query(`SELECT COUNT(*)::int AS c FROM ${TABLE} ${where}`, params);
  const total = totalRes.rows[0].c;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * pageSize;

  const listParams = [...params, pageSize, offset];
  const rowsRes = await pgPool.query(
    `SELECT * FROM ${TABLE} ${where} ORDER BY vin LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams
  );
  return { vehicles: rowsRes.rows.map(rowToVehicle), total, page: currentPage, pageSize, totalPages };
}

async function pgFindByVin(vin) {
  const res = await pgPool.query(`SELECT * FROM ${TABLE} WHERE vin = $1`, [vin]);
  return res.rows.length ? rowToVehicle(res.rows[0]) : null;
}

async function pgFindById(id) {
  const res = await pgPool.query(`SELECT * FROM ${TABLE} WHERE id = $1`, [id]);
  return res.rows.length ? rowToVehicle(res.rows[0]) : null;
}

async function pgFindManyByVins(vins) {
  const map = new Map();
  if (!vins.length) return map;
  for (const part of chunk([...new Set(vins)], INSERT_CHUNK_SIZE)) {
    const res = await pgPool.query(`SELECT * FROM ${TABLE} WHERE vin = ANY($1)`, [part]);
    for (const row of res.rows) map.set(row.vin, rowToVehicle(row));
  }
  return map;
}

async function pgExistsByVin(vin, excludeId) {
  const res = excludeId
    ? await pgPool.query(`SELECT 1 FROM ${TABLE} WHERE vin = $1 AND id <> $2`, [vin, excludeId])
    : await pgPool.query(`SELECT 1 FROM ${TABLE} WHERE vin = $1`, [vin]);
  return res.rowCount > 0;
}

async function pgExistingVinSet() {
  const res = await pgPool.query(`SELECT vin FROM ${TABLE}`);
  return new Set(res.rows.map(r => r.vin));
}

async function pgCreate(vehicle) {
  await pgPool.query(
    `INSERT INTO ${TABLE} (id, vin, ata, purchase_date, warranty_start_date, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [vehicle.id, vehicle.vin, vehicle.ata, vehicle.purchaseDate, vehicle.warrantyStartDate, vehicle.createdBy, vehicle.createdAt, vehicle.updatedAt]
  );
  return vehicle;
}

async function pgUpdate(id, patch) {
  const sets = [];
  const values = [];
  const setCol = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };
  if ('vin' in patch) setCol('vin', patch.vin);
  if ('ata' in patch) setCol('ata', patch.ata);
  if ('purchaseDate' in patch) setCol('purchase_date', patch.purchaseDate);
  if ('warrantyStartDate' in patch) setCol('warranty_start_date', patch.warrantyStartDate);
  setCol('updated_at', patch.updatedAt);
  values.push(id);
  const res = await pgPool.query(
    `UPDATE ${TABLE} SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  return res.rows.length ? rowToVehicle(res.rows[0]) : null;
}

async function pgRemove(id) {
  const res = await pgPool.query(`DELETE FROM ${TABLE} WHERE id = $1`, [id]);
  return res.rowCount > 0;
}

async function pgResetToSeed(seedVehicles) {
  await pgPool.query(`TRUNCATE ${TABLE}`);
  await pgBulkInsert(seedVehicles || []);
}

// One-time migration: older deployments (before this file existed) kept
// vehicles inside db.js's single JSONB blob, as db.vehicles. If that array
// is still sitting in the freshly-loaded blob, move its rows into the real
// table and strip it out of the blob so it never gets reprocessed. Safe to
// call on every boot — ON CONFLICT DO NOTHING makes it a no-op once the
// migration has already happened, and it only ever touches db.vehicles.
async function pgMigrateLegacyBlobVehicles() {
  if (!Array.isArray(db.vehicles) || !db.vehicles.length) return { migrated: 0 };
  const legacy = db.vehicles;
  console.log(`  [mg-approval] Migrating ${legacy.length} vehicle record(s) out of the old JSON blob into their own Postgres table (one-time)...`);
  const insertedCount = await pgBulkInsert(legacy);
  delete db.vehicles;
  await persist();
  console.log(`  [mg-approval] Vehicle migration complete: ${insertedCount} row(s) inserted (${legacy.length - insertedCount} already present).`);
  return { migrated: insertedCount };
}

// ---- File backend (local dev, no DATABASE_URL) -------------------------
// Same behavior as before this file existed: vehicles live on db.vehicles,
// mutated in place. Callers in routes/vehicles.js still call db.js's own
// persist() afterward, exactly as every other route does.

function fileList({ search, page, pageSize }) {
  let list = search ? db.vehicles.filter(v => v.vin.includes(search)) : db.vehicles;
  list = [...list].sort((a, b) => a.vin.localeCompare(b.vin));
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  return { vehicles: list.slice(start, start + pageSize), total, page: currentPage, pageSize, totalPages };
}

function fileFindByVin(vin) {
  return db.vehicles.find(v => v.vin.toUpperCase() === vin.toUpperCase()) || null;
}

function fileFindById(id) {
  return db.vehicles.find(v => v.id === id) || null;
}

function fileFindManyByVins(vins) {
  const wanted = new Set(vins.map(v => v.toUpperCase()));
  const map = new Map();
  for (const v of db.vehicles) {
    if (wanted.has(v.vin.toUpperCase())) map.set(v.vin.toUpperCase(), v);
  }
  return map;
}

function fileExistsByVin(vin, excludeId) {
  return db.vehicles.some(v => (!excludeId || v.id !== excludeId) && v.vin.toUpperCase() === vin.toUpperCase());
}

function fileExistingVinSet() {
  return new Set(db.vehicles.map(v => v.vin.toUpperCase()));
}

function fileCreate(vehicle) {
  db.vehicles.push(vehicle);
  return vehicle;
}

function fileBulkInsert(vehicles) {
  db.vehicles.push(...vehicles);
  return vehicles.length;
}

function fileUpdate(id, patch) {
  const vehicle = db.vehicles.find(v => v.id === id);
  if (!vehicle) return null;
  Object.assign(vehicle, patch);
  return vehicle;
}

function fileRemove(id) {
  const before = db.vehicles.length;
  db.vehicles = db.vehicles.filter(v => v.id !== id);
  return db.vehicles.length < before;
}

function fileResetToSeed(seedVehicles) {
  db.vehicles = seedVehicles || [];
}

// ---- Public interface — dispatches by backend --------------------------

async function init() {
  if (USE_POSTGRES) {
    await pgEnsureTable();
    await pgMigrateLegacyBlobVehicles();
  } else if (!Array.isArray(db.vehicles)) {
    db.vehicles = [];
  }
}

async function resetToSeed(seedVehicles) {
  if (USE_POSTGRES) return pgResetToSeed(seedVehicles);
  return fileResetToSeed(seedVehicles);
}

async function list(opts) {
  return USE_POSTGRES ? pgList(opts) : fileList(opts);
}

async function findByVin(vin) {
  return USE_POSTGRES ? pgFindByVin(vin) : fileFindByVin(vin);
}

async function findById(id) {
  return USE_POSTGRES ? pgFindById(id) : fileFindById(id);
}

async function findManyByVins(vins) {
  return USE_POSTGRES ? pgFindManyByVins(vins) : fileFindManyByVins(vins);
}

async function existsByVin(vin, excludeId) {
  return USE_POSTGRES ? pgExistsByVin(vin, excludeId) : fileExistsByVin(vin, excludeId);
}

async function existingVinSet() {
  return USE_POSTGRES ? pgExistingVinSet() : fileExistingVinSet();
}

async function create(vehicle) {
  return USE_POSTGRES ? pgCreate(vehicle) : fileCreate(vehicle);
}

// vehicles: already-validated, already-deduped vehicle objects to insert.
// Returns the number actually inserted.
async function bulkInsert(vehicles) {
  if (!vehicles.length) return 0;
  return USE_POSTGRES ? pgBulkInsert(vehicles) : fileBulkInsert(vehicles);
}

async function update(id, patch) {
  return USE_POSTGRES ? pgUpdate(id, patch) : fileUpdate(id, patch);
}

async function remove(id) {
  return USE_POSTGRES ? pgRemove(id) : fileRemove(id);
}

module.exports = {
  init,
  resetToSeed,
  list,
  findByVin,
  findById,
  findManyByVins,
  existsByVin,
  existingVinSet,
  create,
  bulkInsert,
  update,
  remove,
};
