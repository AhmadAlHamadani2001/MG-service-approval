const express = require('express');
const bcrypt = require('bcryptjs');
const { db, persist } = require('../db');
const { signToken, requireAuth } = require('../auth');
const { ApiError, logAudit } = require('../stateMachine');

const router = express.Router();

function publicUser(u) {
  return { id: u.id, employeeCode: u.employeeCode, fullName: u.fullName, email: u.email, role: u.role };
}

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  const user = db.users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
  if (!user || !user.isActive || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// Self-service password change — every internal role can change their own
// password (no admin action needed for this, unlike account creation or
// deactivation). req.user is the live record from db.users (see auth.js's
// requireAuth), so updating it here updates the same object the rest of
// this request cycle already has in hand.
router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');

    if (!currentPassword || !bcrypt.compareSync(currentPassword, req.user.passwordHash)) {
      throw new ApiError(400, 'Current password is incorrect.', 'INCORRECT_CURRENT_PASSWORD');
    }
    if (newPassword.length < 8) {
      throw new ApiError(400, 'New password must be at least 8 characters.', 'WEAK_PASSWORD');
    }

    req.user.passwordHash = bcrypt.hashSync(newPassword, 8);
    req.user.updatedAt = new Date().toISOString();
    // No password values in the audit diff — only that a change happened.
    logAudit({ entityType: 'USER', entityId: req.user.id, action: 'CHANGE_PASSWORD', actor: req.user });
    await persist();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
