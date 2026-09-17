const jwt = require('jsonwebtoken');
const { db } = require('./db');

// In production (NODE_ENV=production, which Render and most hosts set
// automatically) a real JWT_SECRET is required — refuse to boot without one
// rather than silently signing every session with a secret that ships in
// this repo. Local `npm start` keeps working with zero setup via the demo
// fallback below.
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('');
  console.error('  [mg-approval] Refusing to start: NODE_ENV=production but no JWT_SECRET is');
  console.error('  set. Set a long random JWT_SECRET environment variable before deploying —');
  console.error('  e.g. `openssl rand -hex 32` — so sessions aren\'t signed with the secret');
  console.error('  that ships in this repo\'s source code.');
  console.error('');
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.warn('  [mg-approval] No JWT_SECRET set — using a local-demo default. Set your own');
  console.warn('  before running this anywhere but your own machine.');
}
const JWT_SECRET = process.env.JWT_SECRET || 'mg-service-approval-local-demo-secret';
const ACCESS_TOKEN_TTL = '8h';

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, name: user.fullName },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [, token] = header.split(' ');
  if (!token) return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.users.find(u => u.id === payload.sub && u.isActive);
    if (!user) return res.status(401).json({ error: 'Account not found or deactivated.' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `This action requires role ${roles.join(' or ')}.` });
    }
    next();
  };
}

module.exports = { signToken, requireAuth, requireRole, JWT_SECRET };
