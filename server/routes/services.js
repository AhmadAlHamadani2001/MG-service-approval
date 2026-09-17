const express = require('express');
const { db, uuid, persist } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { ApiError, logAudit } = require('../stateMachine');

const router = express.Router();
router.use(requireAuth);

function validateServicePayload(body, { partial = false } = {}) {
  const errors = [];
  if (!partial || body.serviceCode !== undefined) {
    if (!body.serviceCode || typeof body.serviceCode !== 'string') errors.push('serviceCode is required.');
  }
  if (!partial || body.description !== undefined) {
    if (!body.description || typeof body.description !== 'string') errors.push('description is required.');
  }
  if (!partial || body.laborHours !== undefined) {
    if (typeof body.laborHours !== 'number' || body.laborHours < 0) errors.push('laborHours must be a number >= 0.');
  }
  if (!partial || body.price !== undefined) {
    if (typeof body.price !== 'number' || body.price < 0) errors.push('price must be a number >= 0.');
  }
  if (!partial || body.approvalLevel !== undefined) {
    if (!['FINANCE', 'SALES_MANAGER'].includes(body.approvalLevel)) errors.push('approvalLevel must be "FINANCE" or "SALES_MANAGER".');
  }
  if (errors.length) throw new ApiError(400, errors.join(' '));
}

router.get('/', (req, res) => {
  const includeInactive = req.query.includeInactive === 'true' && req.user.role === 'AFTER_SALES_ADMIN';
  const list = db.services
    .filter(s => includeInactive || s.isActive)
    .sort((a, b) => a.serviceCode.localeCompare(b.serviceCode));
  res.json({ services: list });
});

router.post('/', requireRole('AFTER_SALES_ADMIN'), async (req, res, next) => {
  try {
    validateServicePayload(req.body);
    const { serviceCode, description, category, laborHours, price, approvalLevel } = req.body;
    if (db.services.some(s => s.serviceCode.toLowerCase() === serviceCode.toLowerCase())) {
      throw new ApiError(409, `Service code "${serviceCode}" already exists.`);
    }
    const now = new Date().toISOString();
    const service = {
      id: uuid(), serviceCode, description, category: category || null,
      laborHours, price, approvalLevel, isActive: true, createdBy: req.user.id, createdAt: now, updatedAt: now,
    };
    db.services.push(service);
    logAudit({ entityType: 'SERVICE', entityId: service.id, action: 'CREATE', actor: req.user, diff: { after: service } });
    await persist();
    res.status(201).json({ service });
  } catch (err) { next(err); }
});

// Bulk import — used by the "download template / upload CSV" flow on the
// Aftersales Admin catalog page. The frontend parses the CSV client-side and
// posts an array of row objects here; each row is validated and created
// independently so one bad row doesn't block the rest of the batch.
router.post('/bulk-import', requireRole('AFTER_SALES_ADMIN'), async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) throw new ApiError(400, 'No rows to import.', 'NO_ROWS');

    const created = [];
    const skipped = [];
    const now = new Date().toISOString();
    const seenCodes = new Set(db.services.map(s => s.serviceCode.toLowerCase()));

    rows.forEach((raw, idx) => {
      const rowNum = idx + 2; // +1 for header row, +1 for 1-indexing
      const serviceCode = String(raw.serviceCode || '').trim();
      const description = String(raw.description || '').trim();
      const category = raw.category ? String(raw.category).trim() : null;
      const laborHours = Number(raw.laborHours);
      const price = Number(raw.price);
      const approvalLevelRaw = String(raw.approvalLevel || '').trim().toUpperCase();
      const approvalLevel = approvalLevelRaw === 'SALES_MANAGER' ? 'SALES_MANAGER' : 'FINANCE';

      if (!serviceCode || !description || !Number.isFinite(laborHours) || laborHours < 0 || !Number.isFinite(price) || price < 0) {
        skipped.push({ row: rowNum, serviceCode: serviceCode || null, reason: 'Missing or invalid fields (serviceCode, description, laborHours, price are all required).' });
        return;
      }
      if (seenCodes.has(serviceCode.toLowerCase())) {
        skipped.push({ row: rowNum, serviceCode, reason: `Service code "${serviceCode}" already exists.` });
        return;
      }
      const service = {
        id: uuid(), serviceCode, description, category,
        laborHours, price, approvalLevel, isActive: true, createdBy: req.user.id, createdAt: now, updatedAt: now,
      };
      db.services.push(service);
      seenCodes.add(serviceCode.toLowerCase());
      created.push(service);
    });

    if (created.length) {
      logAudit({ entityType: 'SERVICE', entityId: null, action: 'BULK_IMPORT', actor: req.user, diff: { createdCount: created.length, skippedCount: skipped.length } });
      await persist();
    }
    res.status(201).json({ created, skipped });
  } catch (err) { next(err); }
});

router.patch('/:id', requireRole('AFTER_SALES_ADMIN'), async (req, res, next) => {
  try {
    const service = db.services.find(s => s.id === req.params.id);
    if (!service) throw new ApiError(404, 'Service not found.');
    validateServicePayload(req.body, { partial: true });
    const before = { ...service };
    const { serviceCode, description, category, laborHours, price, isActive, approvalLevel } = req.body;
    if (serviceCode !== undefined) service.serviceCode = serviceCode;
    if (description !== undefined) service.description = description;
    if (category !== undefined) service.category = category;
    if (laborHours !== undefined) service.laborHours = laborHours;
    if (price !== undefined) service.price = price;
    if (isActive !== undefined) service.isActive = isActive;
    if (approvalLevel !== undefined) service.approvalLevel = approvalLevel;
    service.updatedAt = new Date().toISOString();
    logAudit({ entityType: 'SERVICE', entityId: service.id, action: 'UPDATE', actor: req.user, diff: { before, after: service } });
    await persist();
    res.json({ service });
  } catch (err) { next(err); }
});

// A real, permanent delete — distinct from PATCH { isActive: false }, which
// just deactivates (hides it from new requests but keeps history intact).
// Deleting is only allowed when the service has never been used on any
// request, so historical request line items never end up pointing at a
// service that no longer exists.
router.delete('/:id', requireRole('AFTER_SALES_ADMIN'), async (req, res, next) => {
  try {
    const service = db.services.find(s => s.id === req.params.id);
    if (!service) throw new ApiError(404, 'Service not found.');
    const usedInRequests = db.requestItems.some(i => i.serviceId === service.id);
    if (usedInRequests) {
      throw new ApiError(409, 'This service has already been used on a request and can\'t be deleted — deactivate it instead so history stays intact.', 'SERVICE_IN_USE');
    }
    db.services = db.services.filter(s => s.id !== service.id);
    logAudit({ entityType: 'SERVICE', entityId: service.id, action: 'DELETE', actor: req.user, diff: { before: service } });
    await persist();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
