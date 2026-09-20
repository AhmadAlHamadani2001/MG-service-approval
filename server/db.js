// Storage layer for the app's single in-memory "db" object (branches, users,
// services, requests, ...). Two backends:
//
//   - No DATABASE_URL set (local dev, `npm start` with zero setup): the
//     whole db object is read from / written to a local JSON file, exactly
//     as before.
//   - DATABASE_URL set (production): the whole db object is stored as one
//     JSONB blob in a single-row Postgres table. This keeps every existing
//     route/business-logic file completely unchanged (they only ever touch
//     the shared in-memory `db` object and call `persist()`) while making
//     the app safe to run on a host with an ephemeral filesystem (Render,
//     etc.) and durable/backed-up storage (Supabase Postgres or any other
//     Postgres instance).
//
// This is NOT a normalized relational schema — it's a pragmatic "ship it"
// migration that solves the two real production blockers (ephemeral disk,
// no backups) without rewriting ~2500 lines of route logic into SQL
// queries. Because Node is single-threaded and this app runs as one
// process, there's no in-process race on the in-memory object; the only
// thing that changes is where the durable copy lives.

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DATA_FILE = path.join(__dirname, 'data.json');
const DATABASE_URL = process.env.DATABASE_URL || '';
const USE_POSTGRES = !!DATABASE_URL;
const STATE_ROW_ID = 'main';
const STATE_TABLE = 'mg_approval_state';

let pgPool = null;
if (USE_POSTGRES) {
  // Lazily required so `pg` is only needed when it's actually configured —
  // local dev with no DATABASE_URL never touches this.
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    // Supabase (and most managed Postgres hosts) terminate TLS with a
    // certificate chain that isn't in Node's default trust store out of the
    // box. Encrypting the connection without validating the CA is the
    // common, pragmatic tradeoff for a small internal app like this one.
    ssl: { rejectUnauthorized: false },
    max: 5,
  });
}

function nowIso() {
  return new Date().toISOString();
}

function buildSeed() {
  const now = nowIso();
  const pw = bcrypt.hashSync('password123', 8);

  // Dealership branches. Sales Representative and Aftersales Team accounts
  // are each assigned to exactly one — that assignment is what scopes which
  // requests a given account can see (see canView() in requests.js). Sales
  // Manager, Finance, and Aftersales Admin are central roles with no branch
  // and see every branch.
  const branches = [
    { id: uuidv4(), code: 'G7', name: 'MG Dammam Main 3S', createdAt: now, updatedAt: now },
    { id: uuidv4(), code: 'J7', name: 'MG Madinah 3S', createdAt: now, updatedAt: now },
    { id: uuidv4(), code: 'P7', name: 'MG Qasim 3S', createdAt: now, updatedAt: now },
    { id: uuidv4(), code: 'C7', name: 'MG Ryd- Saleh Square 2S', createdAt: now, updatedAt: now },
    { id: uuidv4(), code: 'E7', name: 'MG RYD-North', createdAt: now, updatedAt: now },
    { id: uuidv4(), code: 'A7', name: 'MG Jeddah Heraa', createdAt: now, updatedAt: now },
    { id: uuidv4(), code: 'B7', name: 'MG Jed Madinah Rd', createdAt: now, updatedAt: now },
    { id: uuidv4(), code: '17', name: 'MG Jeddah Nakheel 2S', createdAt: now, updatedAt: now },
    { id: uuidv4(), code: 'L7', name: 'MG Abha 3S', createdAt: now, updatedAt: now },
    { id: uuidv4(), code: 'K7', name: 'MG Jizan 3S', createdAt: now, updatedAt: now },
    { id: uuidv4(), code: 'P7', name: 'MG Riyadh Quick Service-1', createdAt: now, updatedAt: now },
    { id: uuidv4(), code: 'H7', name: 'Dammam King Fahad', createdAt: now, updatedAt: now },
    { id: uuidv4(), code: 'M7', name: 'MG Makkah 3S', createdAt: now, updatedAt: now },
    { id: uuidv4(), code: '79', name: 'MG Riyadh 1S Khorais Road', createdAt: now, updatedAt: now },
    { id: uuidv4(), code: 'Q7', name: 'MG Riyadh Quick Service-2', createdAt: now, updatedAt: now },
    { id: uuidv4(), code: 'D7', name: 'MG Ryd- Exit 18 2S', createdAt: now, updatedAt: now },
    { id: uuidv4(), code: 'N7', name: 'MG Tabuk 3S', createdAt: now, updatedAt: now },
    { id: uuidv4(), code: '07', name: 'MG Taif 3S', createdAt: now, updatedAt: now },
  ];

  const users = [
    { id: uuidv4(), employeeCode: 'SLS-001', fullName: 'Ahmet Yılmaz', email: 'sales@mg-demo.local', passwordHash: pw, role: 'SALES', branchId: branches[0].id, isActive: true, createdAt: now, updatedAt: now },
    { id: uuidv4(), employeeCode: 'SLM-001', fullName: 'Deniz Kaya', email: 'sales.manager@mg-demo.local', passwordHash: pw, role: 'SALES_MANAGER', branchId: null, isActive: true, createdAt: now, updatedAt: now },
    { id: uuidv4(), employeeCode: 'FIN-001', fullName: 'Selin Aksoy', email: 'finance@mg-demo.local', passwordHash: pw, role: 'FINANCE', branchId: null, isActive: true, createdAt: now, updatedAt: now },
    { id: uuidv4(), employeeCode: 'ASA-001', fullName: 'Mostafa Eldeeb', email: 'aftersales.admin@mg-demo.local', passwordHash: pw, role: 'AFTER_SALES_ADMIN', branchId: null, isActive: true, createdAt: now, updatedAt: now },
    { id: uuidv4(), employeeCode: 'AST-001', fullName: 'Karim Nabil', email: 'aftersales.team@mg-demo.local', passwordHash: pw, role: 'AFTERSALES_TEAM', branchId: branches[0].id, isActive: true, createdAt: now, updatedAt: now },
    { id: uuidv4(), employeeCode: 'SLS-002', fullName: 'Fahad Al-Otaibi', email: 'sales.jeddah@mg-demo.local', passwordHash: pw, role: 'SALES', branchId: branches[5].id, isActive: true, createdAt: now, updatedAt: now },
    { id: uuidv4(), employeeCode: 'AST-002', fullName: 'Yousef Al-Harbi', email: 'aftersales.jeddah@mg-demo.local', passwordHash: pw, role: 'AFTERSALES_TEAM', branchId: branches[5].id, isActive: true, createdAt: now, updatedAt: now },
  ];
  const [sales, salesManager, finance, afterSalesAdmin, afterSalesTeam, salesJeddah, afterSalesTeamJeddah] = users;

  const svc = (code, description, category, laborHours, price, approvalLevel) => ({
    id: uuidv4(), serviceCode: code, description, category, laborHours, price,
    approvalLevel: approvalLevel || 'FINANCE',
    isActive: true, createdBy: afterSalesAdmin.id, createdAt: now, updatedAt: now,
  });

  const services = [
    svc('SVC-0118', 'Front Brake Pad Replacement', 'Mechanical', 1.5, 180, 'FINANCE'),
    svc('SVC-0204', 'Wheel Alignment', 'Mechanical', 1.0, 90, 'FINANCE'),
    svc('SVC-0311', 'Cabin Air Filter Replacement', 'Maintenance', 0.5, 45, 'SALES_MANAGER'),
    svc('SVC-0092', 'Clutch Kit Replacement', 'Mechanical', 4.0, 460, 'FINANCE'),
    svc('SVC-0155', 'Coolant System Flush', 'Maintenance', 1.0, 150, 'SALES_MANAGER'),
    svc('SVC-0231', 'Front Sway Bar Links (pair)', 'Mechanical', 1.5, 130, 'SALES_MANAGER'),
    svc('SVC-0044', 'Battery Replacement', 'Electrical', 0.5, 210, 'SALES_MANAGER'),
    svc('SVC-0077', 'Tyre Set (4) + Alignment', 'Mechanical', 2.0, 740, 'FINANCE'),
    svc('SVC-0410', 'Timing Belt Kit', 'Mechanical', 5.0, 580, 'FINANCE'),
    svc('SVC-0512', 'AC Compressor Replacement', 'Electrical', 3.0, 690, 'FINANCE'),
  ];
  const byCode = Object.fromEntries(services.map(s => [s.serviceCode, s]));

  const requests = [];
  const requestItems = [];
  const statusHistory = [];
  const auditLog = [];
  const comments = [];

  function addRequest({ number, vin, vehicleModel, customerName, status, origin, submittedBy, items, history, comments: reqComments, extra }) {
    const reqId = uuidv4();
    const req = {
      id: reqId,
      requestNumber: number,
      vin, vehicleModel, customerName,
      status,
      origin: origin || 'SALES',
      branchId: null,
      submittedBy,
      financeReviewerId: null,
      salesManagerApproverId: null,
      afterSalesReviewerId: null,
      totalPrice: 0,
      totalLaborHours: 0,
      returnReason: null,
      rejectionReason: null,
      consultNotes: null,
      executionStarted: false,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      ...extra,
    };
    let totalPrice = 0, totalLaborHours = 0;
    for (const it of items) {
      const service = byCode[it.code];
      const item = {
        id: uuidv4(), requestId: reqId, serviceId: service.id,
        quantity: it.qty || 1,
        unitPriceSnapshot: service.price,
        laborHoursSnapshot: service.laborHours,
        source: it.source || 'ORIGINAL',
        itemStatus: 'ACTIVE',
        addedBy: it.addedBy || submittedBy,
        notes: it.notes || null,
        createdAt: now, updatedAt: now,
      };
      totalPrice += item.unitPriceSnapshot * item.quantity;
      totalLaborHours += item.laborHoursSnapshot * item.quantity;
      requestItems.push(item);
    }
    req.totalPrice = totalPrice;
    req.totalLaborHours = totalLaborHours;
    for (const h of history) {
      statusHistory.push({
        id: uuidv4(), requestId: reqId,
        fromStatus: h.from, toStatus: h.to,
        actorId: h.actorId, actorRole: h.actor, action: h.action, comment: h.comment || null,
        createdAt: now,
      });
    }
    for (const c of (reqComments || [])) {
      comments.push({ id: uuidv4(), requestId: reqId, authorId: c.authorId, authorRole: c.authorRole, text: c.text, createdAt: now });
    }
    requests.push(req);
    return req;
  }

  addRequest({
    number: 'REQ-2026-000482', vin: 'WMWXP7C05N2012345', vehicleModel: 'MG ZS', customerName: null,
    status: 'UNDER_AFTER_SALES_ESTIMATION', origin: 'SALES', submittedBy: sales.id,
    items: [{ code: 'SVC-0118' }, { code: 'SVC-0204' }],
    history: [
      { from: null, to: 'PENDING_SALES_APPROVAL', actor: 'SALES', actorId: sales.id, action: 'SUBMIT' },
      { from: 'PENDING_SALES_APPROVAL', to: 'PENDING_FINANCE_APPROVAL', actor: 'SALES_MANAGER', actorId: salesManager.id, action: 'SALES_MANAGER_APPROVE' },
      { from: 'PENDING_FINANCE_APPROVAL', to: 'UNDER_AFTER_SALES_ESTIMATION', actor: 'FINANCE', actorId: finance.id, action: 'DELEGATE_TO_AFTERSALES', comment: 'Confirm suspension noise before approving additional labor.' },
    ],
    extra: { branchId: sales.branchId, salesManagerApproverId: salesManager.id, financeReviewerId: finance.id, consultNotes: 'Confirm suspension noise before approving additional labor.' },
  });

  addRequest({
    number: 'REQ-2026-000479', vin: 'SALFA2A2XJH123456', vehicleModel: 'MG HS', customerName: null,
    status: 'RETURNED_TO_SALES', origin: 'SALES', submittedBy: sales.id,
    items: [{ code: 'SVC-0512' }],
    history: [
      { from: null, to: 'PENDING_SALES_APPROVAL', actor: 'SALES', actorId: sales.id, action: 'SUBMIT' },
      { from: 'PENDING_SALES_APPROVAL', to: 'PENDING_FINANCE_APPROVAL', actor: 'SALES_MANAGER', actorId: salesManager.id, action: 'SALES_MANAGER_APPROVE' },
      { from: 'PENDING_FINANCE_APPROVAL', to: 'RETURNED_TO_SALES', actor: 'FINANCE', actorId: finance.id, action: 'RETURN', comment: 'Please confirm customer approved diagnostic fee before we quote compressor replacement.' },
    ],
    extra: { branchId: sales.branchId, salesManagerApproverId: salesManager.id, financeReviewerId: finance.id, returnReason: 'Please confirm customer approved diagnostic fee before we quote compressor replacement.' },
  });

  addRequest({
    number: 'REQ-2026-000471', vin: 'WVGZZZ1TXJK123456', vehicleModel: 'MG 5', customerName: null,
    status: 'APPROVED_IN_AFTER_SALES', origin: 'SALES', submittedBy: sales.id,
    items: [{ code: 'SVC-0410' }],
    history: [
      { from: null, to: 'PENDING_SALES_APPROVAL', actor: 'SALES', actorId: sales.id, action: 'SUBMIT' },
      { from: 'PENDING_SALES_APPROVAL', to: 'PENDING_FINANCE_APPROVAL', actor: 'SALES_MANAGER', actorId: salesManager.id, action: 'SALES_MANAGER_APPROVE' },
      { from: 'PENDING_FINANCE_APPROVAL', to: 'APPROVED_IN_AFTER_SALES', actor: 'FINANCE', actorId: finance.id, action: 'APPROVE' },
    ],
    extra: { branchId: sales.branchId, salesManagerApproverId: salesManager.id, financeReviewerId: finance.id },
  });

  addRequest({
    number: 'REQ-2026-000465', vin: 'JN1TAAT32A0123456', vehicleModel: 'MG 4 EV', customerName: null,
    status: 'PENDING_SALES_APPROVAL', origin: 'SALES', submittedBy: sales.id,
    items: [{ code: 'SVC-0044' }],
    history: [
      { from: null, to: 'PENDING_SALES_APPROVAL', actor: 'SALES', actorId: sales.id, action: 'SUBMIT' },
    ],
    extra: { branchId: sales.branchId },
  });

  // Walk-in vehicle: Aftersales Team estimates directly, awaiting Sales approval.
  addRequest({
    number: 'REQ-2026-000490', vin: '1HGCM82633A004352', vehicleModel: 'MG 4 EV', customerName: null,
    status: 'PENDING_SALES_APPROVAL', origin: 'WALK_IN', submittedBy: afterSalesTeam.id,
    items: [{ code: 'SVC-0092', addedBy: afterSalesTeam.id }, { code: 'SVC-0155', addedBy: afterSalesTeam.id }],
    history: [
      { from: null, to: 'PENDING_SALES_APPROVAL', actor: 'AFTERSALES_TEAM', actorId: afterSalesTeam.id, action: 'SUBMIT_ESTIMATE', comment: 'Walk-in customer, clutch slipping + coolant leak found on courtesy check.' },
    ],
    comments: [{ authorId: afterSalesTeam.id, authorRole: 'AFTERSALES_TEAM', text: 'Walk-in customer, clutch slipping + coolant leak found on courtesy check.' }],
    extra: { branchId: afterSalesTeam.branchId },
  });

  // A second branch's data, so branch-scoped visibility has something real
  // to demonstrate: Dammam Main (above) shouldn't see any of this, and vice
  // versa.
  addRequest({
    number: 'REQ-2026-000491', vin: 'MJEDDAH1A2B3C4D5E', vehicleModel: 'MG ZS', customerName: null,
    status: 'PENDING_SALES_APPROVAL', origin: 'SALES', submittedBy: salesJeddah.id,
    items: [{ code: 'SVC-0311' }],
    history: [
      { from: null, to: 'PENDING_SALES_APPROVAL', actor: 'SALES', actorId: salesJeddah.id, action: 'SUBMIT' },
    ],
    extra: { branchId: salesJeddah.branchId },
  });

  addRequest({
    number: 'REQ-2026-000492', vin: 'MJEDDAH2B3C4D5E6F', vehicleModel: 'MG HS', customerName: null,
    status: 'UNDER_AFTER_SALES_ESTIMATION', origin: 'WALK_IN', submittedBy: afterSalesTeamJeddah.id,
    items: [{ code: 'SVC-0044', addedBy: afterSalesTeamJeddah.id }],
    history: [
      { from: null, to: 'PENDING_SALES_APPROVAL', actor: 'AFTERSALES_TEAM', actorId: afterSalesTeamJeddah.id, action: 'SUBMIT_ESTIMATE' },
      { from: 'PENDING_SALES_APPROVAL', to: 'PENDING_FINANCE_APPROVAL', actor: 'SALES_MANAGER', actorId: salesManager.id, action: 'SALES_MANAGER_APPROVE' },
      { from: 'PENDING_FINANCE_APPROVAL', to: 'UNDER_AFTER_SALES_ESTIMATION', actor: 'FINANCE', actorId: finance.id, action: 'DELEGATE_TO_AFTERSALES' },
    ],
    extra: { branchId: afterSalesTeamJeddah.branchId, salesManagerApproverId: salesManager.id, financeReviewerId: finance.id },
  });

  // Vehicle master data for the VIN warranty check: VIN + ATA date + the
  // purchase (invoice) date and warranty start date as currently on file.
  // The purchase/warranty-start fields stored here are reference-only — the
  // VIN check always recomputes the authoritative warranty start date live
  // from ATA + whatever purchase date the person checking coverage enters,
  // since the whole point of asking for it again is that this stored value
  // might be wrong. A handful of deliberately varied scenarios:
  //   - WMWXP7C05N2012345: recent purchase, mostly still covered (and shows
  //     the battery's extra 30-day-since-purchase rule blocking a claim
  //     made just a few days too early).
  //   - SALFA2A2XJH123456: purchased over a year ago — every special-period
  //     part has expired.
  //   - WVGZZZ1TXJK123456: purchased more than a year after ATA, so the
  //     warranty auto-started the day after that one-year mark instead of
  //     on the (much later) purchase date — also long expired by now.
  //   - JN1TAAT32A0123456: on file with a purchase date close to ATA, left
  //     in place so entering a different date at query time demonstrates
  //     the purchase-date-mismatch correction guidance.
  //   - MJEDDAH1A2B3C4D5E: a Jeddah-branch vehicle with a mix of expired
  //     and still-covered parts.
  //   - 1HGCM82633A004352 and MJEDDAH2B3C4D5E6F are deliberately NOT given
  //     vehicle records, to demonstrate the "VIN not found" path.
  // warrantyEndDate is the real, sheet-provided overall warranty expiry
  // (distinct from the per-part special-period coverageEndsAt computed in
  // warranty.js) — sample values below are warrantyStartDate + 3 years, for
  // demo purposes only.
  const vehicles = [
    { id: uuidv4(), vin: 'WMWXP7C05N2012345', ata: '2026-06-01', purchaseDate: '2026-08-20', warrantyStartDate: '2026-08-20', warrantyEndDate: '2029-08-20', createdBy: afterSalesAdmin.id, createdAt: now, updatedAt: now },
    { id: uuidv4(), vin: 'SALFA2A2XJH123456', ata: '2025-01-01', purchaseDate: '2025-01-15', warrantyStartDate: '2025-01-15', warrantyEndDate: '2028-01-15', createdBy: afterSalesAdmin.id, createdAt: now, updatedAt: now },
    { id: uuidv4(), vin: 'WVGZZZ1TXJK123456', ata: '2024-06-01', purchaseDate: '2026-08-01', warrantyStartDate: '2025-06-02', warrantyEndDate: '2028-06-02', createdBy: afterSalesAdmin.id, createdAt: now, updatedAt: now },
    { id: uuidv4(), vin: 'JN1TAAT32A0123456', ata: '2026-07-01', purchaseDate: '2026-07-05', warrantyStartDate: '2026-07-05', warrantyEndDate: '2029-07-05', createdBy: afterSalesAdmin.id, createdAt: now, updatedAt: now },
    { id: uuidv4(), vin: 'MJEDDAH1A2B3C4D5E', ata: '2026-05-01', purchaseDate: '2026-06-01', warrantyStartDate: '2026-06-01', warrantyEndDate: '2029-06-01', createdBy: afterSalesAdmin.id, createdAt: now, updatedAt: now },
  ];

  return {
    branches, users, services, requests, requestItems, statusHistory, auditLog, comments, vehicles,
    seq: { request: 492 },
  };
}

// The single shared in-memory state object. Every route file imports THIS
// object by reference (`const { db } = require('../db')`) and mutates it
// directly — init() populates it in place (via Object.assign), it is never
// reassigned, so those references stay valid for the life of the process.
const db = {};

// Migration safety net: a saved state from an older version of this app
// (e.g. from before the Aftersales Admin / Aftersales Team role split, or
// before branches existed) has a different, incompatible shape — fewer demo
// users, no `comments` array, no `branches` array, etc. Rather than
// silently running with mismatched data (which looks like "missing
// accounts" or other confusing bugs with no error), detect that mismatch
// and rebuild fresh seed data automatically. Returns true if it rewrote db.
const EXPECTED_ROLES = ['SALES', 'SALES_MANAGER', 'FINANCE', 'AFTER_SALES_ADMIN', 'AFTERSALES_TEAM'];
function reconcileShape() {
  const hasAllExpectedRoles = Array.isArray(db.users) &&
    EXPECTED_ROLES.every(role => db.users.some(u => u.role === role));
  const hasBranches = Array.isArray(db.branches) && db.branches.length > 0;
  const usersHaveBranchField = Array.isArray(db.users) &&
    db.users.every(u => (u.role !== 'SALES' && u.role !== 'AFTERSALES_TEAM') || 'branchId' in u);
  // Vehicles live in their own Postgres table (see vehiclesStore.js), not in
  // this JSONB blob, once USE_POSTGRES is on — so their absence from db here
  // is the expected, migrated-away state, not a sign of stale/incompatible
  // data. Only file-mode (local dev) still expects db.vehicles as an array.
  const hasVehicles = USE_POSTGRES || Array.isArray(db.vehicles);

  if (!hasAllExpectedRoles || !hasBranches || !usersHaveBranchField || !hasVehicles) {
    console.warn('');
    console.warn('  [mg-approval] Saved data is from an older, incompatible version of this');
    console.warn('  app (it is missing one or more expected user roles, or predates branches /');
    console.warn('  vehicle data). Rebuilding it from the current seed data so all demo');
    console.warn('  accounts and features are available.');
    console.warn('');
    const fresh = buildSeed();
    Object.keys(db).forEach(k => delete db[k]);
    Object.assign(db, fresh);
    return true;
  }
  if (!Array.isArray(db.comments)) {
    // Migration shim: older saved state (pre-Aftersales-Team split) won't have a comments array.
    db.comments = [];
    return true;
  }
  return false;
}

async function ensureTable() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function loadFromPostgres() {
  await ensureTable();
  const { rows } = await pgPool.query(`SELECT data FROM ${STATE_TABLE} WHERE id = $1`, [STATE_ROW_ID]);
  if (rows.length) {
    Object.assign(db, rows[0].data);
    const rewrote = reconcileShape();
    if (rewrote) await persist();
    return;
  }
  const fresh = buildSeed();
  Object.assign(db, fresh);
  await pgPool.query(
    `INSERT INTO ${STATE_TABLE} (id, data) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [STATE_ROW_ID, JSON.stringify(db)]
  );
}

function loadFromFileSync() {
  let loaded = null;
  if (fs.existsSync(DATA_FILE)) {
    try {
      loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (err) {
      console.error('Could not parse data.json, rebuilding seed data:', err.message);
    }
  }
  if (loaded) {
    Object.assign(db, loaded);
  } else {
    Object.assign(db, buildSeed());
  }
  const rewrote = reconcileShape();
  if (rewrote || !loaded) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  }
}

// Must be awaited once, before the server starts accepting requests (see
// server/index.js). Populates the shared `db` object from whichever backend
// is configured.
async function init() {
  if (USE_POSTGRES) {
    await loadFromPostgres();
    console.log('  [mg-approval] Using Postgres-backed storage.');
  } else {
    loadFromFileSync();
    console.log(`  [mg-approval] Using local JSON file storage (${DATA_FILE}).`);
  }
}

async function persist() {
  if (USE_POSTGRES) {
    await pgPool.query(
      `UPDATE ${STATE_TABLE} SET data = $1, updated_at = now() WHERE id = $2`,
      [JSON.stringify(db), STATE_ROW_ID]
    );
  } else {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  }
}

function nextRequestNumber() {
  db.seq.request += 1;
  const year = new Date().getFullYear();
  return `REQ-${year}-${String(db.seq.request).padStart(6, '0')}`;
}

// In Postgres mode, vehicles are stored in their own table (see
// vehiclesStore.js) and must NOT be written back into the blob — otherwise
// the next boot would see a populated db.vehicles and try to re-migrate it.
// The seed vehicles are handed back to the caller (server/reset.js) so it
// can reset the real vehicles table itself via vehiclesStore.resetToSeed().
// In file mode, vehicles stay part of the blob exactly as before.
async function resetToSeed() {
  const fresh = buildSeed();
  if (USE_POSTGRES) {
    const { vehicles: seedVehicles, ...rest } = fresh;
    Object.keys(db).forEach(k => delete db[k]);
    Object.assign(db, rest);
    await persist();
    return { seedVehicles };
  }
  Object.keys(db).forEach(k => delete db[k]);
  Object.assign(db, fresh);
  await persist();
  return { seedVehicles: null };
}

module.exports = { db, init, persist, uuid: uuidv4, nextRequestNumber, resetToSeed, DATA_FILE, USE_POSTGRES, pgPool };
