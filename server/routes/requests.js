const express = require('express');
const { db, uuid, persist, nextRequestNumber } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const {
  ApiError, findRequestOr404, assertStatus, recordHistory, logAudit,
  recomputeTotals, transition,
} = require('../stateMachine');

const router = express.Router();
router.use(requireAuth);

// Catalog administrators manage services only — they have no business here.
router.use((req, res, next) => {
  if (req.user.role === 'AFTER_SALES_ADMIN') {
    return next(new ApiError(403, 'Catalog administrators do not have access to service requests.', 'ADMIN_NO_REQUEST_ACCESS'));
  }
  next();
});

function userSummary(id) {
  const u = db.users.find(x => x.id === id);
  return u ? { id: u.id, fullName: u.fullName, role: u.role } : null;
}

function serviceSummary(id) {
  const s = db.services.find(x => x.id === id);
  return s ? { id: s.id, serviceCode: s.serviceCode, description: s.description, category: s.category } : null;
}

function branchSummary(id) {
  if (!id) return null;
  const b = db.branches.find(x => x.id === id);
  return b ? { id: b.id, code: b.code, name: b.name } : null;
}

function serializeItem(item) {
  return {
    id: item.id,
    quantity: item.quantity,
    unitPriceSnapshot: item.unitPriceSnapshot,
    laborHoursSnapshot: item.laborHoursSnapshot,
    lineTotal: Math.round(item.unitPriceSnapshot * item.quantity * 100) / 100,
    source: item.source,
    itemStatus: item.itemStatus,
    notes: item.notes,
    service: serviceSummary(item.serviceId),
  };
}

function serializeComment(c) {
  return { id: c.id, text: c.text, createdAt: c.createdAt, author: userSummary(c.authorId) };
}

function computeApprovalLevel(request) {
  const items = db.requestItems.filter(i => i.requestId === request.id && i.itemStatus === 'ACTIVE');
  const needsFinance = items.some(i => {
    const service = db.services.find(s => s.id === i.serviceId);
    return !service || service.approvalLevel !== 'SALES_MANAGER';
  });
  return needsFinance ? 'FINANCE' : 'SALES_MANAGER';
}

function serializeRequest(request, { withDetail = false } = {}) {
  const base = {
    id: request.id,
    requestNumber: request.requestNumber,
    vin: request.vin,
    vehicleModel: request.vehicleModel,
    customerName: request.customerName,
    status: request.status,
    origin: request.origin,
    branch: branchSummary(request.branchId),
    totalPrice: request.totalPrice,
    totalLaborHours: request.totalLaborHours,
    executionStarted: !!request.executionStarted,
    submittedBy: userSummary(request.submittedBy),
    financeReviewer: userSummary(request.financeReviewerId),
    salesManagerApprover: userSummary(request.salesManagerApproverId),
    afterSalesReviewer: userSummary(request.afterSalesReviewerId),
    approvalLevel: request.status === 'PENDING_SALES_APPROVAL' ? computeApprovalLevel(request) : null,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    closedAt: request.closedAt,
  };
  if (!withDetail) return base;
  return {
    ...base,
    returnReason: request.returnReason,
    rejectionReason: request.rejectionReason,
    consultNotes: request.consultNotes,
    items: db.requestItems.filter(i => i.requestId === request.id).map(serializeItem),
    comments: db.comments
      .filter(c => c.requestId === request.id)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .map(serializeComment),
    history: db.statusHistory
      .filter(h => h.requestId === request.id)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .map(h => ({
        fromStatus: h.fromStatus, toStatus: h.toStatus, action: h.action,
        comment: h.comment, createdAt: h.createdAt, actor: userSummary(h.actorId),
      })),
  };
}

// Sales Representative and Aftersales Team accounts each belong to one
// branch, and only see requests tied to that branch — that's the whole
// point of branches. Sales Manager, Finance, and Aftersales Admin are
// central roles (no branchId) and are never restricted by it.
function sameBranch(user, request) {
  if (!user.branchId) return true;
  return request.branchId === user.branchId;
}

function canView(user, request) {
  if (user.role === 'SALES') return sameBranch(user, request);
  if (user.role === 'SALES_MANAGER') return true;
  if (user.role === 'FINANCE') return true;
  if (user.role === 'AFTERSALES_TEAM') {
    return sameBranch(user, request) &&
      (request.origin === 'WALK_IN' ||
        ['UNDER_AFTER_SALES_ESTIMATION', 'APPROVED_IN_AFTER_SALES', 'RETURNED_TO_AFTERSALES', 'CLOSED'].includes(request.status));
  }
  return false;
}

function loadAndAuthorize(req, id) {
  const request = findRequestOr404(id);
  if (!canView(req.user, request)) throw new ApiError(403, 'You do not have access to this request.', 'REQUEST_ACCESS_DENIED');
  return request;
}

// The mutating Aftersales Team routes below (estimation, resubmit-estimate,
// resubmit-to-finance, start-execution, close) look the request up directly
// rather than through loadAndAuthorize/canView, so each needs its own branch
// check — otherwise a branch-scoped account could act on another branch's
// request via the API even though it never appears in their queues.
function assertSameBranch(user, request) {
  if (!sameBranch(user, request)) {
    throw new ApiError(403, 'This request belongs to a different branch.', 'DIFFERENT_BRANCH');
  }
}

function buildItemsFromPayload(items, source) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, 'At least one service line item is required.', 'ITEMS_REQUIRED');
  }
  return items.map(raw => {
    const service = db.services.find(s => s.id === raw.serviceId && s.isActive);
    if (!service) throw new ApiError(400, `Unknown or inactive service: ${raw.serviceId}`, 'UNKNOWN_SERVICE');
    const quantity = Number.isInteger(raw.quantity) && raw.quantity > 0 ? raw.quantity : 1;
    return {
      id: uuid(),
      serviceId: service.id,
      quantity,
      unitPriceSnapshot: service.price,
      laborHoursSnapshot: service.laborHours,
      source,
      itemStatus: 'ACTIVE',
      addedBy: null, // filled by caller
      notes: raw.notes || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  });
}

function pushComment(request, actor, text) {
  if (!text || !text.trim()) return;
  db.comments.push({
    id: uuid(), requestId: request.id, authorId: actor.id, authorRole: actor.role,
    text: text.trim(), createdAt: new Date().toISOString(),
  });
}

// ---- List & detail ------------------------------------------------------

router.get('/', (req, res) => {
  let list = db.requests.filter(r => canView(req.user, r));
  if (req.query.status) {
    const statuses = String(req.query.status).split(',');
    list = list.filter(r => statuses.includes(r.status));
  }
  list = [...list].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json({ requests: list.map(r => serializeRequest(r)) });
});

router.get('/:id', (req, res) => {
  const request = loadAndAuthorize(req, req.params.id);
  res.json({ request: serializeRequest(request, { withDetail: true }) });
});

router.get('/:id/audit-log', (req, res) => {
  const request = loadAndAuthorize(req, req.params.id);
  const entries = db.auditLog
    .filter(a => a.entityType === 'REQUEST' && a.entityId === request.id)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .map(a => ({ action: a.action, diff: a.diff, createdAt: a.createdAt, actor: userSummary(a.actorId) }));
  res.json({ auditLog: entries });
});

router.post('/:id/comments', async (req, res, next) => {
  try {
    const request = loadAndAuthorize(req, req.params.id);
    const text = (req.body?.text || '').trim();
    if (!text) throw new ApiError(400, 'Comment text is required.', 'COMMENT_REQUIRED');
    pushComment(request, req.user, text);
    request.updatedAt = new Date().toISOString();
    logAudit({ entityType: 'REQUEST', entityId: request.id, action: 'COMMENT', actor: req.user, diff: { text } });
    await persist();
    res.status(201).json({ request: serializeRequest(request, { withDetail: true }) });
  } catch (err) { next(err); }
});

// ---- Sales: create (normal flow) & resubmit -----------------------------

router.post('/', requireRole('SALES'), async (req, res, next) => {
  try {
    const { vin, vehicleModel, customerName, items, comment } = req.body || {};
    if (!vin || !vin.trim()) {
      throw new ApiError(400, 'A VIN is required.', 'INVALID_VIN');
    }
    const newItems = buildItemsFromPayload(items, 'ORIGINAL').map(i => ({ ...i, requestId: null, addedBy: req.user.id }));

    const now = new Date().toISOString();
    const request = {
      id: uuid(),
      requestNumber: nextRequestNumber(),
      vin: vin.trim().toUpperCase(),
      vehicleModel: vehicleModel || null,
      customerName: customerName || null,
      status: 'PENDING_SALES_APPROVAL',
      origin: 'SALES',
      branchId: req.user.branchId || null,
      submittedBy: req.user.id,
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
    };
    newItems.forEach(i => { i.requestId = request.id; });
    db.requests.push(request);
    db.requestItems.push(...newItems);
    recomputeTotals(request);
    if (comment) pushComment(request, req.user, comment);
    recordHistory(request, { from: null, to: request.status, actor: req.user, action: 'SUBMIT', comment });
    logAudit({ entityType: 'REQUEST', entityId: request.id, action: 'CREATE', actor: req.user });
    await persist();
    res.status(201).json({ request: serializeRequest(request, { withDetail: true }) });
  } catch (err) { next(err); }
});

router.patch('/:id/resubmit', requireRole('SALES'), async (req, res, next) => {
  try {
    const request = findRequestOr404(req.params.id);
    if (request.submittedBy !== req.user.id) throw new ApiError(403, 'Only the original submitter can resubmit this request.', 'NOT_OWNER');
    assertStatus(request, 'RETURNED_TO_SALES', 'resubmit this request');

    const { vin, vehicleModel, customerName, items, comment } = req.body || {};
    if (vin) {
      request.vin = vin.trim().toUpperCase();
    }
    if (vehicleModel !== undefined) request.vehicleModel = vehicleModel;
    if (customerName !== undefined) request.customerName = customerName;

    if (items) {
      db.requestItems
        .filter(i => i.requestId === request.id && i.itemStatus === 'ACTIVE')
        .forEach(i => { i.itemStatus = 'REMOVED'; i.updatedAt = new Date().toISOString(); });
      const newItems = buildItemsFromPayload(items, 'ORIGINAL').map(i => ({ ...i, requestId: request.id, addedBy: req.user.id }));
      db.requestItems.push(...newItems);
    }
    recomputeTotals(request);
    request.returnReason = null;
    if (comment) pushComment(request, req.user, comment);
    // If this request already cleared Sales Manager approval once (and was later
    // returned by Finance), resubmitting sends it straight back to Finance —
    // no need to have the Sales Manager approve it a second time. Otherwise
    // (the Sales Manager returned it directly) it goes back to the Sales
    // Manager queue.
    const destination = request.salesManagerApproverId ? 'PENDING_FINANCE_APPROVAL' : 'PENDING_SALES_APPROVAL';
    await transition(request, { to: destination, actor: req.user, action: 'RESUBMIT', comment });
    res.json({ request: serializeRequest(request, { withDetail: true }) });
  } catch (err) { next(err); }
});

// ---- Aftersales Team: walk-in estimate (direct flow) --------------------

router.post('/walk-in', requireRole('AFTERSALES_TEAM'), async (req, res, next) => {
  try {
    const { vin, vehicleModel, customerName, items, comment } = req.body || {};
    if (!vin || !vin.trim()) {
      throw new ApiError(400, 'A VIN is required.', 'INVALID_VIN');
    }
    const newItems = buildItemsFromPayload(items, 'ORIGINAL').map(i => ({ ...i, requestId: null, addedBy: req.user.id }));

    const now = new Date().toISOString();
    const request = {
      id: uuid(),
      requestNumber: nextRequestNumber(),
      vin: vin.trim().toUpperCase(),
      vehicleModel: vehicleModel || null,
      customerName: customerName || null,
      status: 'PENDING_SALES_APPROVAL',
      origin: 'WALK_IN',
      branchId: req.user.branchId || null,
      submittedBy: req.user.id,
      financeReviewerId: null,
      salesManagerApproverId: null,
      afterSalesReviewerId: req.user.id,
      totalPrice: 0,
      totalLaborHours: 0,
      returnReason: null,
      rejectionReason: null,
      consultNotes: null,
      executionStarted: false,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    newItems.forEach(i => { i.requestId = request.id; });
    db.requests.push(request);
    db.requestItems.push(...newItems);
    recomputeTotals(request);
    if (comment) pushComment(request, req.user, comment);
    recordHistory(request, { from: null, to: request.status, actor: req.user, action: 'SUBMIT_ESTIMATE', comment });
    logAudit({ entityType: 'REQUEST', entityId: request.id, action: 'CREATE', actor: req.user });
    await persist();
    res.status(201).json({ request: serializeRequest(request, { withDetail: true }) });
  } catch (err) { next(err); }
});

router.patch('/:id/resubmit-estimate', requireRole('AFTERSALES_TEAM'), async (req, res, next) => {
  try {
    const request = findRequestOr404(req.params.id);
    assertSameBranch(req.user, request);
    assertStatus(request, 'RETURNED_TO_AFTERSALES', 'resubmit this estimate');
    const { vin, vehicleModel, customerName, items, comment } = req.body || {};
    if (vin) {
      request.vin = vin.trim().toUpperCase();
    }
    if (vehicleModel !== undefined) request.vehicleModel = vehicleModel;
    if (customerName !== undefined) request.customerName = customerName;
    if (items) {
      db.requestItems
        .filter(i => i.requestId === request.id && i.itemStatus === 'ACTIVE')
        .forEach(i => { i.itemStatus = 'REMOVED'; i.updatedAt = new Date().toISOString(); });
      const newItems = buildItemsFromPayload(items, 'ORIGINAL').map(i => ({ ...i, requestId: request.id, addedBy: req.user.id }));
      db.requestItems.push(...newItems);
    }
    recomputeTotals(request);
    request.returnReason = null;
    if (comment) pushComment(request, req.user, comment);
    // Same disambiguation as /resubmit above: if a Sales Manager already
    // approved this request once, a Finance return sends it straight back to
    // Finance on resubmission rather than through the Sales Manager again.
    const destination = request.salesManagerApproverId ? 'PENDING_FINANCE_APPROVAL' : 'PENDING_SALES_APPROVAL';
    await transition(request, { to: destination, actor: req.user, action: 'RESUBMIT_ESTIMATE', comment });
    res.json({ request: serializeRequest(request, { withDetail: true }) });
  } catch (err) { next(err); }
});

// ---- Sales Manager: approve / reject / return a pending request ----------
// Every request — whether submitted by a Sales Rep or estimated by the
// Aftersales Team on a walk-in — is first reviewed by the Sales Manager.
// If every active line item on the request is flagged "Sales Manager"
// approval level (set by the Aftersales Admin on the service catalog), the
// Sales Manager's approval alone is enough and the request goes straight to
// Aftersales for execution. Otherwise it still needs Finance to sign off.

router.post('/:id/sales-manager-approve', requireRole('SALES_MANAGER'), async (req, res, next) => {
  try {
    const request = findRequestOr404(req.params.id);
    assertStatus(request, 'PENDING_SALES_APPROVAL', 'approve this request');
    const level = computeApprovalLevel(request);
    const to = level === 'SALES_MANAGER' ? 'APPROVED_IN_AFTER_SALES' : 'PENDING_FINANCE_APPROVAL';
    await transition(request, {
      to, actor: req.user, action: 'SALES_MANAGER_APPROVE', comment: req.body?.comment,
      extra: { salesManagerApproverId: req.user.id },
    });
    res.json({ request: serializeRequest(request, { withDetail: true }) });
  } catch (err) { next(err); }
});

router.post('/:id/sales-manager-reject', requireRole('SALES_MANAGER'), async (req, res, next) => {
  try {
    const request = findRequestOr404(req.params.id);
    assertStatus(request, 'PENDING_SALES_APPROVAL', 'reject this request');
    const reason = (req.body?.reason || '').trim();
    if (!reason) throw new ApiError(400, 'A rejection reason is required.', 'REASON_REQUIRED');
    await transition(request, {
      to: 'REJECTED', actor: req.user, action: 'SALES_MANAGER_REJECT', comment: reason,
      extra: { rejectionReason: reason },
    });
    res.json({ request: serializeRequest(request, { withDetail: true }) });
  } catch (err) { next(err); }
});

router.post('/:id/sales-manager-return', requireRole('SALES_MANAGER'), async (req, res, next) => {
  try {
    const request = findRequestOr404(req.params.id);
    assertStatus(request, 'PENDING_SALES_APPROVAL', 'return this request');
    const reason = (req.body?.reason || '').trim();
    if (!reason) throw new ApiError(400, 'A return reason is required so the submitter knows what to fix.', 'REASON_REQUIRED');
    const to = request.origin === 'WALK_IN' ? 'RETURNED_TO_AFTERSALES' : 'RETURNED_TO_SALES';
    await transition(request, {
      to, actor: req.user, action: 'SALES_MANAGER_RETURN', comment: reason,
      // Deliberately does NOT set salesManagerApproverId — that field is the
      // signal /resubmit and /resubmit-estimate use to decide whether a
      // returned request needs the Sales Manager's review again (it does,
      // since they never approved it) or can skip straight back to Finance
      // (only true once the Sales Manager has actually approved it).
      extra: { returnReason: reason },
    });
    res.json({ request: serializeRequest(request, { withDetail: true }) });
  } catch (err) { next(err); }
});

// ---- Finance: approve / reject / return / delegate -----------------------

router.post('/:id/approve', requireRole('FINANCE'), async (req, res, next) => {
  try {
    const request = findRequestOr404(req.params.id);
    assertStatus(request, 'PENDING_FINANCE_APPROVAL', 'approve this request');
    await transition(request, {
      to: 'APPROVED_IN_AFTER_SALES', actor: req.user, action: 'FINANCE_APPROVE', comment: req.body?.comment,
      extra: { financeReviewerId: req.user.id },
    });
    res.json({ request: serializeRequest(request, { withDetail: true }) });
  } catch (err) { next(err); }
});

router.post('/:id/reject', requireRole('FINANCE'), async (req, res, next) => {
  try {
    const request = findRequestOr404(req.params.id);
    assertStatus(request, 'PENDING_FINANCE_APPROVAL', 'reject this request');
    const reason = (req.body?.reason || '').trim();
    if (!reason) throw new ApiError(400, 'A rejection reason is required.', 'REASON_REQUIRED');
    await transition(request, {
      to: 'REJECTED', actor: req.user, action: 'FINANCE_REJECT', comment: reason,
      extra: { financeReviewerId: req.user.id, rejectionReason: reason },
    });
    res.json({ request: serializeRequest(request, { withDetail: true }) });
  } catch (err) { next(err); }
});

router.post('/:id/return', requireRole('FINANCE'), async (req, res, next) => {
  try {
    const request = findRequestOr404(req.params.id);
    assertStatus(request, 'PENDING_FINANCE_APPROVAL', 'return this request');
    const reason = (req.body?.reason || '').trim();
    if (!reason) throw new ApiError(400, 'A return reason is required.', 'REASON_REQUIRED');
    const to = request.origin === 'WALK_IN' ? 'RETURNED_TO_AFTERSALES' : 'RETURNED_TO_SALES';
    await transition(request, {
      to, actor: req.user, action: 'FINANCE_RETURN', comment: reason,
      extra: { financeReviewerId: req.user.id, returnReason: reason },
    });
    res.json({ request: serializeRequest(request, { withDetail: true }) });
  } catch (err) { next(err); }
});

router.post('/:id/delegate', requireRole('FINANCE'), async (req, res, next) => {
  try {
    const request = findRequestOr404(req.params.id);
    assertStatus(request, 'PENDING_FINANCE_APPROVAL', 'delegate this request to the Aftersales Team');
    if (request.origin === 'WALK_IN') {
      throw new ApiError(409, 'This request is already an Aftersales Team estimate — it cannot be delegated again.', 'ALREADY_AFTERSALES_ORIGIN');
    }
    const notes = (req.body?.notes || '').trim() || null;
    await transition(request, {
      to: 'UNDER_AFTER_SALES_ESTIMATION', actor: req.user, action: 'DELEGATE_TO_AFTERSALES', comment: notes,
      extra: { financeReviewerId: req.user.id, consultNotes: notes },
    });
    res.json({ request: serializeRequest(request, { withDetail: true }) });
  } catch (err) { next(err); }
});

// ---- Aftersales Team: estimation, execution, closing ----------------------

router.patch('/:id/estimation-items', requireRole('AFTERSALES_TEAM'), async (req, res, next) => {
  try {
    const request = findRequestOr404(req.params.id);
    assertSameBranch(req.user, request);
    assertStatus(request, 'UNDER_AFTER_SALES_ESTIMATION', 'edit items on this request');
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) throw new ApiError(400, 'Provide at least one item action (ADD, MODIFY, or REMOVE).', 'ITEM_ACTIONS_REQUIRED');

    for (const action of items) {
      if (action.action === 'ADD') {
        const service = db.services.find(s => s.id === action.serviceId && s.isActive);
        if (!service) throw new ApiError(400, `Unknown or inactive service: ${action.serviceId}`, 'UNKNOWN_SERVICE');
        const quantity = Number.isInteger(action.quantity) && action.quantity > 0 ? action.quantity : 1;
        db.requestItems.push({
          id: uuid(), requestId: request.id, serviceId: service.id, quantity,
          unitPriceSnapshot: service.price, laborHoursSnapshot: service.laborHours,
          source: 'AFTERSALES_ADDED', itemStatus: 'ACTIVE', addedBy: req.user.id,
          notes: action.notes || null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
      } else if (action.action === 'MODIFY') {
        const item = db.requestItems.find(i => i.id === action.itemId && i.requestId === request.id && i.itemStatus === 'ACTIVE');
        if (!item) throw new ApiError(400, `Active item not found: ${action.itemId}`, 'ITEM_NOT_FOUND');
        if (Number.isInteger(action.quantity) && action.quantity > 0) item.quantity = action.quantity;
        if (action.notes !== undefined) item.notes = action.notes;
        item.source = 'AFTERSALES_MODIFIED';
        item.updatedAt = new Date().toISOString();
      } else if (action.action === 'REMOVE') {
        const item = db.requestItems.find(i => i.id === action.itemId && i.requestId === request.id && i.itemStatus === 'ACTIVE');
        if (!item) throw new ApiError(400, `Active item not found: ${action.itemId}`, 'ITEM_NOT_FOUND');
        item.itemStatus = 'REMOVED';
        item.updatedAt = new Date().toISOString();
      } else {
        throw new ApiError(400, `Unknown item action: ${action.action}`, 'UNKNOWN_ITEM_ACTION');
      }
    }

    recomputeTotals(request);
    request.afterSalesReviewerId = req.user.id;
    request.updatedAt = new Date().toISOString();
    if (req.body?.comment) pushComment(request, req.user, req.body.comment);
    logAudit({ entityType: 'REQUEST', entityId: request.id, action: 'ITEMS_UPDATED', actor: req.user, diff: { items } });
    await persist();
    res.json({ request: serializeRequest(request, { withDetail: true }) });
  } catch (err) { next(err); }
});

router.post('/:id/resubmit-to-finance', requireRole('AFTERSALES_TEAM'), async (req, res, next) => {
  try {
    const request = findRequestOr404(req.params.id);
    assertSameBranch(req.user, request);
    assertStatus(request, 'UNDER_AFTER_SALES_ESTIMATION', 'resubmit this request to Finance');
    await transition(request, {
      to: 'PENDING_FINANCE_APPROVAL', actor: req.user, action: 'RESUBMIT_TO_FINANCE', comment: req.body?.summary,
      extra: { afterSalesReviewerId: req.user.id },
    });
    res.json({ request: serializeRequest(request, { withDetail: true }) });
  } catch (err) { next(err); }
});

router.post('/:id/start-execution', requireRole('AFTERSALES_TEAM'), async (req, res, next) => {
  try {
    const request = findRequestOr404(req.params.id);
    assertSameBranch(req.user, request);
    assertStatus(request, 'APPROVED_IN_AFTER_SALES', 'start execution on this request');
    if (request.executionStarted) throw new ApiError(409, 'Execution has already started on this request.', 'ALREADY_STARTED');
    request.executionStarted = true;
    request.afterSalesReviewerId = req.user.id;
    request.updatedAt = new Date().toISOString();
    recordHistory(request, { from: request.status, to: request.status, actor: req.user, action: 'START_EXECUTION' });
    logAudit({ entityType: 'REQUEST', entityId: request.id, action: 'START_EXECUTION', actor: req.user });
    await persist();
    res.json({ request: serializeRequest(request, { withDetail: true }) });
  } catch (err) { next(err); }
});

router.post('/:id/close', requireRole('AFTERSALES_TEAM'), async (req, res, next) => {
  try {
    const request = findRequestOr404(req.params.id);
    assertSameBranch(req.user, request);
    assertStatus(request, 'APPROVED_IN_AFTER_SALES', 'close this request');
    const comment = req.body?.comment;
    if (comment) pushComment(request, req.user, comment);
    // The UI no longer has a separate "start execution" step — closing an
    // approved case both starts and finishes execution in one action, so we
    // still mark executionStarted for anything downstream that reads it.
    await transition(request, {
      to: 'CLOSED', actor: req.user, action: 'CLOSE_REQUEST', comment,
      extra: { afterSalesReviewerId: req.user.id, closedAt: new Date().toISOString(), executionStarted: true },
    });
    res.json({ request: serializeRequest(request, { withDetail: true }) });
  } catch (err) { next(err); }
});

module.exports = router;
