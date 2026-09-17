// Central place for everything the state-transition map in the design doc
// describes: which statuses exist, who may move a request out of which
// status, and the bookkeeping (status history + audit log + recomputed
// totals) every transition performs. Route handlers call into here instead
// of mutating request.status directly, so there is exactly one place that
// can move a request between states.

const { db, uuid, persist } = require('./db');

const STATUSES = [
  'PENDING_SALES_APPROVAL',
  'PENDING_FINANCE_APPROVAL',
  'UNDER_AFTER_SALES_ESTIMATION',
  'RETURNED_TO_SALES',
  'RETURNED_TO_AFTERSALES',
  'APPROVED_IN_AFTER_SALES',
  'REJECTED',
  'CLOSED',
];

class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || null;
  }
}

function findRequestOr404(id) {
  const request = db.requests.find(r => r.id === id || r.requestNumber === id);
  if (!request) throw new ApiError(404, `No request found with id/number "${id}".`);
  return request;
}

function assertStatus(request, allowed, actionLabel) {
  const list = Array.isArray(allowed) ? allowed : [allowed];
  if (!list.includes(request.status)) {
    throw new ApiError(
      409,
      `Cannot ${actionLabel}: request is "${request.status}", not ${list.join(' or ')}.`
    );
  }
}

function recordHistory(request, { from, to, actor, action, comment }) {
  db.statusHistory.push({
    id: uuid(),
    requestId: request.id,
    fromStatus: from,
    toStatus: to,
    actorId: actor.id,
    actorRole: actor.role,
    action,
    comment: comment || null,
    createdAt: new Date().toISOString(),
  });
}

function logAudit({ entityType, entityId, action, actor, diff }) {
  db.auditLog.push({
    id: uuid(),
    entityType,
    entityId,
    action,
    actorId: actor ? actor.id : null,
    diff: diff || null,
    createdAt: new Date().toISOString(),
  });
}

function recomputeTotals(request) {
  const items = db.requestItems.filter(i => i.requestId === request.id && i.itemStatus === 'ACTIVE');
  request.totalPrice = round2(items.reduce((sum, i) => sum + i.unitPriceSnapshot * i.quantity, 0));
  request.totalLaborHours = round2(items.reduce((sum, i) => sum + i.laborHoursSnapshot * i.quantity, 0));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function transition(request, { to, actor, action, comment, extra }) {
  const from = request.status;
  request.status = to;
  request.updatedAt = new Date().toISOString();
  if (extra) Object.assign(request, extra);
  recordHistory(request, { from, to, actor, action, comment });
  logAudit({ entityType: 'REQUEST', entityId: request.id, action: `STATUS_CHANGE:${action}`, actor, diff: { from, to, comment } });
  await persist();
}

module.exports = {
  STATUSES,
  ApiError,
  findRequestOr404,
  assertStatus,
  recordHistory,
  logAudit,
  recomputeTotals,
  transition,
  round2,
};
