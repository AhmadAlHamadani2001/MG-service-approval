const express = require('express');
const { db, uuid, persist } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { ApiError, logAudit } = require('../stateMachine');

const router = express.Router();
router.use(requireAuth);

function publicBranch(b) {
  return { id: b.id, code: b.code, name: b.name };
}

// Read is open to any signed-in account — the branch list is not sensitive,
// and the Aftersales Admin's "create account" form needs it. Only the
// Aftersales Admin can add or remove branches.
router.get('/', (req, res) => {
  const list = [...db.branches].sort((a, b) => a.name.localeCompare(b.name));
  res.json({ branches: list.map(publicBranch) });
});

router.post('/', requireRole('AFTER_SALES_ADMIN'), async (req, res, next) => {
  try {
    const code = String(req.body?.code || '').trim();
    const name = String(req.body?.name || '').trim();
    if (!code || !name) {
      throw new ApiError(400, 'Branch code and name are both required.', 'BRANCH_FIELDS_REQUIRED');
    }
    const now = new Date().toISOString();
    const branch = { id: uuid(), code, name, createdAt: now, updatedAt: now };
    db.branches.push(branch);
    logAudit({ entityType: 'BRANCH', entityId: branch.id, action: 'CREATE', actor: req.user, diff: { after: branch } });
    await persist();
    res.status(201).json({ branch: publicBranch(branch) });
  } catch (err) { next(err); }
});

// Requests keep a snapshot of the branch they were created under (so history
// stays intact even if a branch is later removed), but a branch that still
// has any account assigned to it can't be deleted — reassign or deactivate
// those accounts first so no account is left pointing at a branch that no
// longer exists.
router.delete('/:id', requireRole('AFTER_SALES_ADMIN'), async (req, res, next) => {
  try {
    const branch = db.branches.find(b => b.id === req.params.id);
    if (!branch) throw new ApiError(404, 'Branch not found.');
    const inUse = db.users.some(u => u.branchId === branch.id);
    if (inUse) {
      throw new ApiError(409, 'This branch still has one or more accounts assigned to it — reassign or deactivate those accounts first.', 'BRANCH_IN_USE');
    }
    db.branches = db.branches.filter(b => b.id !== branch.id);
    logAudit({ entityType: 'BRANCH', entityId: branch.id, action: 'DELETE', actor: req.user, diff: { before: branch } });
    await persist();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
