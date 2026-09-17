require('dotenv').config();
const path = require('path');
const express = require('express');

const { init } = require('./db');
const authRoutes = require('./routes/auth');
const serviceRoutes = require('./routes/services');
const requestRoutes = require('./routes/requests');
const auditRoutes = require('./routes/audit');
const branchRoutes = require('./routes/branches');
const userRoutes = require('./routes/users');
const vehicleRoutes = require('./routes/vehicles');
const { ApiError } = require('./stateMachine');

const app = express();
const PORT = process.env.PORT || 4000;

// The vehicle bulk-import UI now uploads its file as multipart form data
// (handled by multer in routes/vehicles.js, not by this JSON parser), but a
// few other bulk actions (e.g. the service catalog's CSV import) still post
// a JSON array in the body, so this is raised well past Express's 100kb
// default rather than tuned to any one route.
app.use(express.json({ limit: '10mb' }));

// ---- API ------------------------------------------------------------------
app.use('/api/auth', authRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/audit-log', auditRoutes);
app.use('/api/branches', branchRoutes);
app.use('/api/users', userRoutes);
app.use('/api/vehicles', vehicleRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---- Static frontend --------------------------------------------------------
// The HTML shell is served with no-cache so a rebuilt app.js/styles.css is
// always picked up on the next reload instead of being served stale from the
// browser's disk cache (the versioned ?v= query string on each asset link
// then forces a fresh fetch of that asset too).
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---- Error handling ---------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error. Check the terminal running `npm start` for details.' });
});

async function start() {
  // Populate the shared db object (from Postgres if DATABASE_URL is set,
  // otherwise the local JSON file) before accepting any requests.
  await init();

  app.listen(PORT, () => {
    console.log('');
    console.log('  MG Service Approval System — running');
    console.log(`  → http://localhost:${PORT}`);
    console.log('');
    console.log('  Demo accounts (password: password123, unless changed via Change Password)');
    console.log('    sales@mg-demo.local               Sales Representative · Dammam Main (G7)');
    console.log('    sales.manager@mg-demo.local        Sales Manager');
    console.log('    finance@mg-demo.local             Finance Approver');
    console.log('    aftersales.admin@mg-demo.local    Aftersales Admin (catalog, accounts, branches, vehicles)');
    console.log('    aftersales.team@mg-demo.local     Aftersales Team · Dammam Main (G7)');
    console.log('    sales.jeddah@mg-demo.local         Sales Representative · Jeddah Heraa (A7)');
    console.log('    aftersales.jeddah@mg-demo.local    Aftersales Team · Jeddah Heraa (A7)');
    console.log('');
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
