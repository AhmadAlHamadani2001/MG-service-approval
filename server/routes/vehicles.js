const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { Readable } = require('stream');
const { db, uuid, persist } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { ApiError, logAudit } = require('../stateMachine');
const { parseDateOnly, fmt, todayDateOnly, computeWarrantyStart, checkCoverage } = require('../warranty');

const router = express.Router();
router.use(requireAuth);

// The vehicle table is meant to hold a full dealer management system export
// (hundreds of thousands of rows is the expected scale, not the exception),
// so every read and write path below is written to stay cheap at that size:
// bulk import is a single streamed file upload parsed and persisted once
// (never a giant JSON array shipped through the request body), the list
// endpoint is paginated + searchable rather than ever returning the whole
// table, and the admin UI (app.js) only ever asks for one page at a time.

// Vehicle master data (VIN / ATA / purchase date / warranty start date) is
// uploaded and maintained by the Aftersales Admin, alongside the service
// catalog, accounts, and branches. The VIN warranty-check lookup itself is
// open to every internal role — Sales, Sales Manager, Finance, Aftersales
// Team, and Aftersales Admin all need to be able to tell a customer whether
// a repair falls inside the special-period warranty.

function publicVehicle(v) {
  return {
    id: v.id,
    vin: v.vin,
    ata: v.ata,
    purchaseDate: v.purchaseDate,
    warrantyStartDate: v.warrantyStartDate,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

// Parses+validates the three date fields shared by create/update. Returns
// { ataDate, purchaseDate, warrantyStartDate } (Date|null for the first two,
// formatted "YYYY-MM-DD" string|null for warrantyStartDate) or throws.
function parseVehicleDates(body, { partial = false } = {}) {
  const errors = [];
  let ataDate = null;
  let purchaseDate = null;
  let warrantyStartDate = null;

  if (!partial || body.ata !== undefined) {
    ataDate = parseDateOnly(body.ata);
    if (!ataDate) errors.push('A valid ATA date (YYYY-MM-DD) is required.');
  }
  if (!partial || body.purchaseDate !== undefined) {
    purchaseDate = parseDateOnly(body.purchaseDate);
    if (!purchaseDate) errors.push('A valid purchase date (YYYY-MM-DD) is required.');
  }
  if (body.warrantyStartDate !== undefined && body.warrantyStartDate !== null && String(body.warrantyStartDate).trim() !== '') {
    const wsd = parseDateOnly(body.warrantyStartDate);
    if (!wsd) errors.push('Warranty start date, if provided, must be a valid date (YYYY-MM-DD).');
    else warrantyStartDate = fmt(wsd);
  }
  if (errors.length) throw new ApiError(400, errors.join(' '), 'INVALID_VEHICLE_DATA');
  return { ataDate, purchaseDate, warrantyStartDate };
}

// Paginated + searchable — at real-export scale (hundreds of thousands of
// vehicles) this must never hand the whole table to the client in one
// response, and the admin UI below only ever requests one page.
router.get('/', requireRole('AFTER_SALES_ADMIN'), (req, res) => {
  const search = String(req.query.search || '').trim().toUpperCase();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));

  let list = search ? db.vehicles.filter(v => v.vin.includes(search)) : db.vehicles;
  list = [...list].sort((a, b) => a.vin.localeCompare(b.vin));

  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;

  res.json({
    vehicles: list.slice(start, start + pageSize).map(publicVehicle),
    total,
    page: currentPage,
    pageSize,
    totalPages,
  });
});

router.post('/', requireRole('AFTER_SALES_ADMIN'), async (req, res, next) => {
  try {
    const vin = String(req.body?.vin || '').trim().toUpperCase();
    if (!vin) throw new ApiError(400, 'VIN is required.', 'INVALID_VEHICLE_DATA');
    if (db.vehicles.some(v => v.vin.toUpperCase() === vin)) {
      throw new ApiError(409, `A vehicle with VIN "${vin}" already exists.`, 'VIN_IN_USE');
    }
    const { ataDate, purchaseDate, warrantyStartDate } = parseVehicleDates(req.body);

    const now = new Date().toISOString();
    const vehicle = {
      id: uuid(),
      vin,
      ata: fmt(ataDate),
      purchaseDate: fmt(purchaseDate),
      // If the admin doesn't supply a warranty start date, derive one from
      // ATA + purchase date so the record isn't left blank — this stored
      // value is reference-only, though: the VIN check always recomputes the
      // authoritative start date live from ATA + whatever purchase date the
      // person checking coverage enters.
      warrantyStartDate: warrantyStartDate || fmt(computeWarrantyStart(ataDate, purchaseDate).date),
      createdBy: req.user.id,
      createdAt: now,
      updatedAt: now,
    };
    db.vehicles.push(vehicle);
    logAudit({ entityType: 'VEHICLE', entityId: vehicle.id, action: 'CREATE', actor: req.user, diff: { after: vehicle } });
    await persist();
    res.status(201).json({ vehicle: publicVehicle(vehicle) });
  } catch (err) { next(err); }
});

// Bulk import — same "download template / upload CSV" flow already used for
// the service catalog. Columns: vin, ata, purchaseDate, warrantyStartDate
// (warrantyStartDate is optional; left blank it's derived from ata+purchaseDate).
router.post('/bulk-import', requireRole('AFTER_SALES_ADMIN'), async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) throw new ApiError(400, 'No rows to import.', 'NO_ROWS');

    const created = [];
    const skipped = [];
    const now = new Date().toISOString();
    const seenVins = new Set(db.vehicles.map(v => v.vin.toUpperCase()));

    rows.forEach((raw, idx) => {
      const rowNum = idx + 2; // +1 for header row, +1 for 1-indexing
      const vin = String(raw.vin || '').trim().toUpperCase();
      const ataDate = parseDateOnly(raw.ata);
      const purchaseDate = parseDateOnly(raw.purchaseDate);
      const warrantyStartRaw = raw.warrantyStartDate ? String(raw.warrantyStartDate).trim() : '';
      const warrantyStartDate = warrantyStartRaw ? parseDateOnly(warrantyStartRaw) : null;

      if (!vin || !ataDate || !purchaseDate || (warrantyStartRaw && !warrantyStartDate)) {
        skipped.push({ row: rowNum, vin: vin || null, reason: 'Missing or invalid fields (vin, ata, and purchaseDate are all required and must be valid dates).' });
        return;
      }
      if (seenVins.has(vin)) {
        skipped.push({ row: rowNum, vin, reason: `A vehicle with VIN "${vin}" already exists.` });
        return;
      }
      const vehicle = {
        id: uuid(),
        vin,
        ata: fmt(ataDate),
        purchaseDate: fmt(purchaseDate),
        warrantyStartDate: warrantyStartDate ? fmt(warrantyStartDate) : fmt(computeWarrantyStart(ataDate, purchaseDate).date),
        createdBy: req.user.id,
        createdAt: now,
        updatedAt: now,
      };
      db.vehicles.push(vehicle);
      seenVins.add(vin);
      created.push(vehicle);
    });

    if (created.length) {
      logAudit({ entityType: 'VEHICLE', entityId: null, action: 'BULK_IMPORT', actor: req.user, diff: { createdCount: created.length, skippedCount: skipped.length } });
      await persist();
    }
    res.status(201).json({ created, skipped });
  } catch (err) { next(err); }
});

// ---- Bulk import from a real export file (.csv or .xlsx) -----------------
//
// This is the path meant for actual dealer-management-system exports —
// potentially hundreds of thousands of rows — so the file is uploaded as a
// real multipart file (never JSON-encoded and shipped as a request body,
// which is both slow to build in the browser and would hit Express's body
// size limit) and parsed server-side with a streaming-friendly library.
//
// Header matching is flexible on purpose: it accepts this app's own simple
// template (vin/ata/purchaseDate/warrantyStartDate) AND the column names a
// real SAIC/MG dealer export actually uses ("Vehicle VIN" or "System VIN",
// "ATA", "Purchase Date") — those happen to already match this system's own
// field names, which is what an admin is most likely to have on hand.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 }, // 150MB — comfortably covers a 170k+ row export
});

function handleVehicleFileUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new ApiError(400, 'That file is too large (max 150MB).', 'FILE_TOO_LARGE'));
    }
    return next(new ApiError(400, 'Could not read the uploaded file.', 'INVALID_FILE'));
  });
}

function normalizeHeader(h) {
  return String(h ?? '').trim().toLowerCase();
}

const VIN_HEADER_CANDIDATES = ['vehicle vin', 'vin', 'system vin'];
const ATA_HEADER_CANDIDATES = ['ata'];
const PURCHASE_HEADER_CANDIDATES = ['purchase date', 'purchasedate'];
const WARRANTY_START_HEADER_CANDIDATES = ['warranty start date', 'warrantystartdate'];

function findHeaderColumn(headerMap, candidates) {
  for (const c of candidates) {
    if (headerMap.has(c)) return headerMap.get(c);
  }
  return null;
}

// Cell values coming out of a real export can be a genuine Date (a
// date-typed spreadsheet cell) or plain text like "2011/08/18" — the real
// SAIC/MG export stores its date columns as text, not date cells. Handles
// both, plus this app's own "YYYY-MM-DD" template format.
function parseFlexibleDate(raw) {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return new Date(Date.UTC(raw.getFullYear(), raw.getMonth(), raw.getDate()));
  }
  if (raw && typeof raw === 'object' && 'result' in raw) return parseFlexibleDate(raw.result);
  const str = String(raw ?? '').trim();
  if (!str) return null;
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(str);
  if (!m) return null;
  return parseDateOnly(`${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`);
}

const MAX_SKIPPED_DETAILS = 200;

router.post('/bulk-import-file', requireRole('AFTER_SALES_ADMIN'), handleVehicleFileUpload, async (req, res, next) => {
  try {
    if (!req.file) throw new ApiError(400, 'No file uploaded.', 'NO_ROWS');
    const filename = (req.file.originalname || '').toLowerCase();
    const isCsv = filename.endsWith('.csv') || req.file.mimetype === 'text/csv';

    let headerMap = null;
    let vinCol = null, ataCol = null, purchaseCol = null, warrantyCol = null;
    let created = 0;
    let skippedCount = 0;
    let totalDataRows = 0;
    const skippedSample = [];
    const now = new Date().toISOString();
    const seenVins = new Set(db.vehicles.map(v => v.vin.toUpperCase()));

    // rowValues is a sparse 1-indexed array — rowValues[n] is column n,
    // exactly like ExcelJS's own row.values, so both the streaming XLSX
    // reader below and the plain CSV reader can share this one function.
    function processRow(rowNumber, rowValues) {
      if (rowNumber === 1) {
        headerMap = new Map();
        rowValues.forEach((v, colNumber) => {
          if (colNumber === 0) return;
          headerMap.set(normalizeHeader(v), colNumber);
        });
        vinCol = findHeaderColumn(headerMap, VIN_HEADER_CANDIDATES);
        ataCol = findHeaderColumn(headerMap, ATA_HEADER_CANDIDATES);
        purchaseCol = findHeaderColumn(headerMap, PURCHASE_HEADER_CANDIDATES);
        warrantyCol = findHeaderColumn(headerMap, WARRANTY_START_HEADER_CANDIDATES);
        return;
      }
      if (!vinCol || !ataCol || !purchaseCol) return; // malformed header — reported once after the loop

      totalDataRows += 1;
      const vin = String(rowValues[vinCol] ?? '').trim().toUpperCase();
      const ataDate = parseFlexibleDate(rowValues[ataCol]);
      const purchaseDate = parseFlexibleDate(rowValues[purchaseCol]);
      const warrantyStartDate = warrantyCol ? parseFlexibleDate(rowValues[warrantyCol]) : null;

      if (!vin || !ataDate || !purchaseDate) {
        skippedCount += 1;
        if (skippedSample.length < MAX_SKIPPED_DETAILS) {
          skippedSample.push({ row: rowNumber, vin: vin || null, reason: 'Missing or unreadable VIN, ATA date, or purchase date.' });
        }
        return;
      }
      if (seenVins.has(vin)) {
        skippedCount += 1;
        if (skippedSample.length < MAX_SKIPPED_DETAILS) {
          skippedSample.push({ row: rowNumber, vin, reason: `A vehicle with VIN "${vin}" already exists.` });
        }
        return;
      }

      const vehicle = {
        id: uuid(),
        vin,
        ata: fmt(ataDate),
        purchaseDate: fmt(purchaseDate),
        warrantyStartDate: warrantyStartDate ? fmt(warrantyStartDate) : fmt(computeWarrantyStart(ataDate, purchaseDate).date),
        createdBy: req.user.id,
        createdAt: now,
        updatedAt: now,
      };
      db.vehicles.push(vehicle);
      seenVins.add(vin);
      created += 1;
    }

    try {
      if (isCsv) {
        // CSV files are read the plain (non-streaming) way — a CSV of even
        // a few hundred thousand rows is a small fraction of the size an
        // equivalent .xlsx would be, so this stays fast without the extra
        // complexity of the streaming reader.
        const workbook = new ExcelJS.Workbook();
        await workbook.csv.read(Readable.from(req.file.buffer));
        const worksheet = workbook.worksheets[0];
        if (!worksheet) throw new ApiError(400, 'That file has no rows to import.', 'NO_ROWS');
        worksheet.eachRow((row, rowNumber) => processRow(rowNumber, row.values));
      } else {
        // A real dealer-management-system export can be a 60+ column,
        // 100,000+ row .xlsx — ExcelJS's plain workbook.xlsx.load() builds
        // an in-memory model of every cell in every column before we ever
        // get to read the 3-4 we actually need, which is what makes a big
        // export slow to import. The streaming reader parses and discards
        // one row at a time instead, which is the whole difference here.
        const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from(req.file.buffer), {
          entries: 'emit', sharedStrings: 'cache', styles: 'cache', hyperlinks: 'ignore', worksheets: 'emit',
        });
        let sawAnySheet = false;
        for await (const worksheetReader of workbookReader) {
          sawAnySheet = true;
          for await (const row of worksheetReader) {
            processRow(row.number, row.values);
          }
          break; // only the first worksheet, same as the CSV/plain-load path
        }
        if (!sawAnySheet) throw new ApiError(400, 'That file has no rows to import.', 'NO_ROWS');
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(400, 'Could not read that file — make sure it is a valid .csv or .xlsx export.', 'INVALID_FILE');
    }

    if (!headerMap) throw new ApiError(400, 'That file has no rows to import.', 'NO_ROWS');
    if (!vinCol || !ataCol || !purchaseCol) {
      throw new ApiError(400, 'Could not find VIN, ATA, and Purchase Date columns in the file\'s header row.', 'INVALID_VEHICLE_DATA');
    }

    // A single persist() for the whole batch, however many rows it was —
    // never one disk write per row.
    if (created) {
      logAudit({
        entityType: 'VEHICLE', entityId: null, action: 'BULK_IMPORT', actor: req.user,
        diff: { createdCount: created, skippedCount, totalRows: totalDataRows, source: req.file.originalname || null },
      });
      await persist();
    }

    res.status(201).json({
      createdCount: created,
      skippedCount,
      totalRows: totalDataRows,
      skippedSample,
      skippedTruncated: skippedCount > skippedSample.length,
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requireRole('AFTER_SALES_ADMIN'), async (req, res, next) => {
  try {
    const vehicle = db.vehicles.find(v => v.id === req.params.id);
    if (!vehicle) throw new ApiError(404, 'Vehicle not found.');
    const before = { ...vehicle };

    if (req.body?.vin !== undefined) {
      const vin = String(req.body.vin || '').trim().toUpperCase();
      if (!vin) throw new ApiError(400, 'VIN is required.', 'INVALID_VEHICLE_DATA');
      if (db.vehicles.some(v => v.id !== vehicle.id && v.vin.toUpperCase() === vin)) {
        throw new ApiError(409, `A vehicle with VIN "${vin}" already exists.`, 'VIN_IN_USE');
      }
      vehicle.vin = vin;
    }

    const { ataDate, purchaseDate, warrantyStartDate } = parseVehicleDates(req.body, { partial: true });
    if (ataDate) vehicle.ata = fmt(ataDate);
    if (purchaseDate) vehicle.purchaseDate = fmt(purchaseDate);
    if (req.body?.warrantyStartDate !== undefined) vehicle.warrantyStartDate = warrantyStartDate;

    vehicle.updatedAt = new Date().toISOString();
    logAudit({ entityType: 'VEHICLE', entityId: vehicle.id, action: 'UPDATE', actor: req.user, diff: { before, after: vehicle } });
    await persist();
    res.json({ vehicle: publicVehicle(vehicle) });
  } catch (err) { next(err); }
});

// A plain delete — nothing else in the system references a vehicle record
// (service requests are keyed by VIN as free text, not by this table), so
// there's no "in use" guard needed the way there is for services/branches.
router.delete('/:id', requireRole('AFTER_SALES_ADMIN'), async (req, res, next) => {
  try {
    const vehicle = db.vehicles.find(v => v.id === req.params.id);
    if (!vehicle) throw new ApiError(404, 'Vehicle not found.');
    db.vehicles = db.vehicles.filter(v => v.id !== vehicle.id);
    logAudit({ entityType: 'VEHICLE', entityId: vehicle.id, action: 'DELETE', actor: req.user, diff: { before: vehicle } });
    await persist();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// The VIN warranty-check itself — open to every authenticated internal
// role. Takes the VIN plus the purchase/invoice date as the person checking
// coverage enters it (the vehicle's own stored purchase date is treated as
// unreliable per the admin's own data, which is exactly why this date is
// asked for again here rather than trusted from the vehicle record).
router.get('/warranty-check', (req, res) => {
  const vin = String(req.query.vin || '').trim().toUpperCase();
  if (!vin) throw new ApiError(400, 'A VIN is required.', 'VIN_REQUIRED');

  const enteredPurchaseDate = parseDateOnly(req.query.purchaseDate);
  if (!enteredPurchaseDate) {
    throw new ApiError(400, 'A valid purchase date, as per the authorized dealer invoice, is required.', 'INVALID_VEHICLE_DATA');
  }

  const vehicle = db.vehicles.find(v => v.vin.toUpperCase() === vin);
  if (!vehicle) {
    throw new ApiError(404, 'No vehicle found with that VIN. Ask the Aftersales Admin to add it to the vehicle data first.', 'VEHICLE_NOT_FOUND');
  }
  if (!vehicle.ata) {
    throw new ApiError(409, 'This vehicle has no ATA date on file, so warranty coverage cannot be calculated yet.', 'MISSING_ATA');
  }

  const ataDate = parseDateOnly(vehicle.ata);
  if (enteredPurchaseDate.getTime() < ataDate.getTime()) {
    throw new ApiError(400, 'The purchase/invoice date cannot be before this vehicle\'s ATA date.', 'PURCHASE_BEFORE_ATA');
  }
  const today = todayDateOnly();
  if (enteredPurchaseDate.getTime() > today.getTime()) {
    throw new ApiError(400, 'The purchase/invoice date cannot be in the future.', 'PURCHASE_IN_FUTURE');
  }

  const result = checkCoverage({ ata: vehicle.ata, purchaseDate: fmt(enteredPurchaseDate) });
  const purchaseDateMismatch = !!vehicle.purchaseDate && vehicle.purchaseDate !== fmt(enteredPurchaseDate);

  res.json({
    vehicle: publicVehicle(vehicle),
    enteredPurchaseDate: fmt(enteredPurchaseDate),
    purchaseDateMismatch,
    ...result,
  });
});

// ---- Bulk VIN warranty inquiry (.csv or .xlsx) ----------------------------
//
// Same "download a template, fill it in, upload it" pattern as the vehicle
// bulk-import above, but read-only and open to every internal role (like the
// single-VIN check itself) — this lets a sales/aftersales person look up
// warranty coverage for a batch of VINs (e.g. from their own worksheet) in
// one pass instead of one at a time. Reuses the same header-matching and
// flexible date parsing as the vehicle import above; only VIN and purchase
// date are needed here, so it also accepts a real export's own columns.
const MAX_BULK_CHECK_ROWS = 2000;

router.post('/warranty-check-bulk', handleVehicleFileUpload, async (req, res, next) => {
  try {
    if (!req.file) throw new ApiError(400, 'No file uploaded.', 'NO_ROWS');
    const filename = (req.file.originalname || '').toLowerCase();
    const isCsv = filename.endsWith('.csv') || req.file.mimetype === 'text/csv';

    let headerMap = null;
    let vinCol = null, purchaseCol = null;
    let totalDataRows = 0;
    const today = todayDateOnly();
    const results = [];

    function processRow(rowNumber, rowValues) {
      if (rowNumber === 1) {
        headerMap = new Map();
        rowValues.forEach((v, colNumber) => {
          if (colNumber === 0) return;
          headerMap.set(normalizeHeader(v), colNumber);
        });
        vinCol = findHeaderColumn(headerMap, VIN_HEADER_CANDIDATES);
        purchaseCol = findHeaderColumn(headerMap, PURCHASE_HEADER_CANDIDATES);
        return;
      }
      if (!vinCol || !purchaseCol) return; // malformed header — reported once after the loop

      totalDataRows += 1;
      // Keep counting past the cap (so totalRows/truncated stay accurate),
      // but stop computing — an inquiry batch has no reason to be anywhere
      // near the vehicle-import scale, and each row here carries a full
      // per-part breakdown, unlike that endpoint's compact created/skipped tally.
      if (results.length >= MAX_BULK_CHECK_ROWS) return;

      const vin = String(rowValues[vinCol] ?? '').trim().toUpperCase();
      const enteredPurchaseDate = parseFlexibleDate(rowValues[purchaseCol]);

      if (!vin) {
        results.push({ row: rowNumber, vin: null, ok: false, error: 'Missing VIN.' });
        return;
      }
      if (!enteredPurchaseDate) {
        results.push({ row: rowNumber, vin, ok: false, error: 'Missing or unreadable purchase date.' });
        return;
      }
      const vehicle = db.vehicles.find(v => v.vin.toUpperCase() === vin);
      if (!vehicle) {
        results.push({ row: rowNumber, vin, ok: false, error: 'No vehicle found with that VIN.' });
        return;
      }
      if (!vehicle.ata) {
        results.push({ row: rowNumber, vin, ok: false, error: 'This vehicle has no ATA date on file.' });
        return;
      }
      const ataDate = parseDateOnly(vehicle.ata);
      if (enteredPurchaseDate.getTime() < ataDate.getTime()) {
        results.push({ row: rowNumber, vin, ok: false, error: 'The purchase date entered is before this vehicle\'s ATA date.' });
        return;
      }
      if (enteredPurchaseDate.getTime() > today.getTime()) {
        results.push({ row: rowNumber, vin, ok: false, error: 'The purchase date entered is in the future.' });
        return;
      }

      const check = checkCoverage({ ata: vehicle.ata, purchaseDate: fmt(enteredPurchaseDate) });
      const purchaseDateMismatch = !!vehicle.purchaseDate && vehicle.purchaseDate !== fmt(enteredPurchaseDate);
      const notCoveredParts = check.parts.filter(p => !p.covered).map(p => p.label);

      results.push({
        row: rowNumber,
        vin,
        ok: true,
        ata: vehicle.ata,
        purchaseDateOnFile: vehicle.purchaseDate,
        enteredPurchaseDate: fmt(enteredPurchaseDate),
        purchaseDateMismatch,
        warrantyStartDate: check.warrantyStartDate,
        warrantyStartAutoTriggered: check.warrantyStartAutoTriggered,
        coveredCount: check.parts.length - notCoveredParts.length,
        notCoveredCount: notCoveredParts.length,
        notCoveredParts,
        // Full per-part covered/not-covered breakdown, in the same fixed
        // order for every vehicle (the special-period part catalog is the
        // same 14 parts regardless of VIN) — this is what lets the results
        // CSV give each part its own column. `reasons` is carried through so
        // a "not covered" cell can say WHY (computed from this specific
        // VIN's actual ATA/purchase/warranty-start dates), not just the bare
        // word "Not covered" for every row.
        parts: check.parts.map(p => ({ label: p.label, covered: p.covered, reasons: p.reasons })),
      });
    }

    try {
      if (isCsv) {
        const workbook = new ExcelJS.Workbook();
        await workbook.csv.read(Readable.from(req.file.buffer));
        const worksheet = workbook.worksheets[0];
        if (!worksheet) throw new ApiError(400, 'That file has no rows to check.', 'NO_ROWS');
        worksheet.eachRow((row, rowNumber) => processRow(rowNumber, row.values));
      } else {
        const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from(req.file.buffer), {
          entries: 'emit', sharedStrings: 'cache', styles: 'cache', hyperlinks: 'ignore', worksheets: 'emit',
        });
        let sawAnySheet = false;
        for await (const worksheetReader of workbookReader) {
          sawAnySheet = true;
          for await (const row of worksheetReader) {
            processRow(row.number, row.values);
          }
          break;
        }
        if (!sawAnySheet) throw new ApiError(400, 'That file has no rows to check.', 'NO_ROWS');
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(400, 'Could not read that file — make sure it is a valid .csv or .xlsx export.', 'INVALID_FILE');
    }

    if (!headerMap) throw new ApiError(400, 'That file has no rows to check.', 'NO_ROWS');
    if (!vinCol || !purchaseCol) {
      throw new ApiError(400, 'Could not find VIN and Purchase Date columns in the file\'s header row.', 'INVALID_VEHICLE_DATA');
    }

    logAudit({
      entityType: 'VEHICLE', entityId: null, action: 'BULK_WARRANTY_CHECK', actor: req.user,
      diff: { totalRows: totalDataRows, checkedCount: results.length, source: req.file.originalname || null },
    });
    await persist();

    res.json({
      totalRows: totalDataRows,
      checkedCount: results.length,
      results,
      truncated: totalDataRows > results.length,
      maxRows: MAX_BULK_CHECK_ROWS,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
