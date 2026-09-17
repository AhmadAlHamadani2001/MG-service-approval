const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

function userSummary(id) {
  const u = db.users.find(x => x.id === id);
  return u ? { id: u.id, fullName: u.fullName, role: u.role } : null;
}

router.get('/', requireAuth, requireRole('FINANCE', 'AFTERSALES_TEAM'), (req, res) => {
  let entries = [...db.auditLog].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (req.query.entityType) entries = entries.filter(e => e.entityType === req.query.entityType);
  entries = entries.slice(0, 200).map(e => ({
    entityType: e.entityType, entityId: e.entityId, action: e.action,
    diff: e.diff, createdAt: e.createdAt, actor: userSummary(e.actorId),
  }));
  res.json({ auditLog: entries });
});

module.exports = router;
