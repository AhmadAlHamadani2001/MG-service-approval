const express = require('express');
const bcrypt = require('bcryptjs');
const { db, uuid, persist } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { ApiError, logAudit } = require('../stateMachine');

const router = express.Router();
router.use(requireAuth);
// Account management is an Aftersales Admin capability, alongside the
// service catalog and the branch list.
router.use(requireRole('AFTER_SALES_ADMIN'));

// WARRANTY_CHECK is a restricted account type: it can sign in and use the
// VIN warranty-check page (single + bulk) only — no service requests, no
// approvals, no admin screens. See routes/requests.js and routes/users.js's
// own admin-only gate above (already excludes it), and public/app.js's
// role-based render() for the frontend side of the restriction.
const ALL_ROLES = ['SALES', 'SALES_MANAGER', 'FINANCE', 'AFTER_SALES_ADMIN', 'AFTERSALES_TEAM', 'WARRANTY_CHECK'];
// Only Sales Representatives and Aftersales Team members belong to one
// specific branch — Sales Manager, Finance, Aftersales Admin, and Warranty
// Checker are central roles that operate across every branch (or, for
// Warranty Checker, no branch at all since it never sees branch-scoped data).
const BRANCH_ROLES = ['SALES', 'AFTERSALES_TEAM'];
const CODE_PREFIX = { SALES: 'SLS', SALES_MANAGER: 'SLM', FINANCE: 'FIN', AFTER_SALES_ADMIN: 'ASA', AFTERSALES_TEAM: 'AST', WARRANTY_CHECK: 'WTC' };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(u) {
  const branch = u.branchId ? db.branches.find(b => b.id === u.branchId) : null;
  return {
    id: u.id,
    employeeCode: u.employeeCode,
    fullName: u.fullName,
    email: u.email,
    role: u.role,
    branchId: u.branchId || null,
    branch: branch ? { id: branch.id, code: branch.code, name: branch.name } : null,
    isActive: u.isActive,
    createdAt: u.createdAt,
  };
}

function nextEmployeeCode(role) {
  const prefix = CODE_PREFIX[role] || 'USR';
  let n = db.users.filter(u => u.role === role).length + 1;
  let code;
  do {
    code = `${prefix}-${String(n).padStart(3, '0')}`;
    n += 1;
  } while (db.users.some(u => u.employeeCode === code));
  return code;
}

router.get('/', (req, res) => {
  const list = [...db.users].sort((a, b) => a.fullName.localeCompare(b.fullName));
  res.json({ users: list.map(publicUser) });
});

router.post('/', async (req, res, next) => {
  try {
    const fullName = String(req.body?.fullName || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const role = req.body?.role;
    const branchId = req.body?.branchId || null;

    const errors = [];
    if (!fullName) errors.push('Full name is required.');
    if (!email || !EMAIL_RE.test(email)) errors.push('A valid email is required.');
    if (!password || password.length < 8) errors.push('Password must be at least 8 characters.');
    if (!ALL_ROLES.includes(role)) errors.push('A valid role is required.');
    if (errors.length) throw new ApiError(400, errors.join(' '), 'INVALID_ACCOUNT');

    if (db.users.some(u => u.email.toLowerCase() === email)) {
      throw new ApiError(409, `An account with email "${email}" already exists.`, 'EMAIL_IN_USE');
    }

    let finalBranchId = null;
    if (BRANCH_ROLES.includes(role)) {
      const branch = db.branches.find(b => b.id === branchId);
      if (!branch) {
        throw new ApiError(400, 'A branch is required for Sales Representative and Aftersales Team accounts.', 'BRANCH_REQUIRED');
      }
      finalBranchId = branch.id;
    }

    const now = new Date().toISOString();
    const user = {
      id: uuid(),
      employeeCode: nextEmployeeCode(role),
      fullName,
      email,
      passwordHash: bcrypt.hashSync(password, 8),
      role,
      branchId: finalBranchId,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    db.users.push(user);
    logAudit({ entityType: 'USER', entityId: user.id, action: 'CREATE', actor: req.user, diff: { role, branchId: finalBranchId } });
    await persist();
    res.status(201).json({ user: publicUser(user) });
  } catch (err) { next(err); }
});

// No hard delete — accounts are referenced throughout request history
// (submitter, approver, reviewer, comment author...), so removing one
// outright would leave broken references. Deactivating blocks sign-in the
// same way a delete would, while keeping history intact.
router.patch('/:id', async (req, res, next) => {
  try {
    const user = db.users.find(u => u.id === req.params.id);
    if (!user) throw new ApiError(404, 'Account not found.');
    if (req.body?.isActive !== undefined) {
      if (user.id === req.user.id && req.body.isActive === false) {
        throw new ApiError(400, 'You cannot deactivate your own account.', 'CANNOT_DEACTIVATE_SELF');
      }
      user.isActive = !!req.body.isActive;
      user.updatedAt = new Date().toISOString();
      logAudit({ entityType: 'USER', entityId: user.id, action: user.isActive ? 'ACTIVATE' : 'DEACTIVATE', actor: req.user });
      await persist();
    }
    res.json({ user: publicUser(user) });
  } catch (err) { next(err); }
});

module.exports = router;
