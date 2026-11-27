'use strict';
require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const db = require('./db');

const {
  PORT = 3000,
  NODE_ENV = 'development',
  ADMIN_USERNAME = 'admin',
  ADMIN_PASSWORD_HASH = '',
  SESSION_SECRET = '',
  TRUST_PROXY = '0'
} = process.env;
const isProd = NODE_ENV === 'production';

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET must be set to a random string of at least 32 characters (see .env.example).');
  process.exit(1);
}
if (!ADMIN_PASSWORD_HASH.startsWith('$2')) {
  console.warn('ADMIN_PASSWORD_HASH is not set. The admin login will refuse every attempt until you set it (npm run hash-password).');
}

const TOPICS = [
  'Software development', 'IT staffing', 'Data engineering', 'AI applications',
  'e-Commerce and payments', 'Internship: Data Engineering',
  'Internship: Web Development', 'Internship: AI Applications'
];
const STATUSES = ['new', 'in_progress', 'closed'];

const app = express();
if (TRUST_PROXY === '1') app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: isProd ? [] : null
    }
  }
}));

app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

app.use(session({
  name: 'sd.sid',
  secret: SESSION_SECRET,
  store: new MySQLStore({ createDatabaseTable: true, clearExpired: true }, db.pool),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'strict', secure: isProd, maxAge: 1000 * 60 * 60 * 8 }
}));

// ---------- Public site ----------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: isProd ? '1h' : 0 }));

const contactLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many messages from this address. Please try again in a few minutes.' } });

const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

app.post('/api/contact', contactLimiter, async (req, res) => {
  const body = req.body || {};
  // Honeypot: real visitors never fill this hidden field.
  if (body.website) return res.status(201).json({ ok: true });

  const name = clean(body.name, 120);
  const email = clean(body.email, 190);
  const company = clean(body.company, 190) || null;
  const topic = TOPICS.includes(body.topic) ? body.topic : 'Software development';
  const message = clean(body.message, 5000);

  if (!name || !EMAIL_RE.test(email) || message.length < 2) {
    return res.status(400).json({ error: 'Please add your name, a valid email and a short message.' });
  }
  try {
    await db.pool.execute(
      'INSERT INTO enquiries (name, email, company, topic, message, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [name, email, company, topic, message, req.ip || null, clean(req.get('user-agent'), 255) || null]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('Failed to save enquiry:', err.message);
    res.status(500).json({ error: 'We could not save your message just now. Please try again or email us.' });
  }
});

// ---------- Admin ----------
const requireAdmin = (req, res, next) => {
  if (req.session && req.session.admin) return next();
  if (req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Please sign in again.' });
  return res.redirect('/admin/login');
};

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, skipSuccessfulRequests: true });

app.get('/admin/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/admin/login', loginLimiter, async (req, res) => {
  const u = clean(req.body.username, 100);
  const p = typeof req.body.password === 'string' ? req.body.password : '';
  const userOk = u === ADMIN_USERNAME;
  // Always run bcrypt so a wrong username takes as long as a wrong password.
  const hash = ADMIN_PASSWORD_HASH.startsWith('$2') ? ADMIN_PASSWORD_HASH : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const passOk = await bcrypt.compare(p, hash).catch(() => false);
  if (!(userOk && passOk && ADMIN_PASSWORD_HASH.startsWith('$2'))) {
    return res.redirect('/admin/login?error=1');
  }
  req.session.regenerate(err => {
    if (err) return res.redirect('/admin/login?error=1');
    req.session.admin = { username: u, at: Date.now() };
    req.session.save(() => res.redirect('/admin'));
  });
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('sd.sid');
    res.redirect('/admin/login');
  });
});

app.get('/admin', requireAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

// List enquiries with search, status / topic filter and paging
app.get('/api/admin/enquiries', requireAdmin, async (req, res) => {
  const q = clean(req.query.q, 100);
  const status = STATUSES.includes(req.query.status) ? req.query.status : '';
  const topic = TOPICS.includes(req.query.topic) ? req.query.topic : '';
  const pageSize = 25;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const where = [];
  const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (topic) { where.push('topic = ?'); args.push(topic); }
  if (q) {
    where.push('(name LIKE ? OR email LIKE ? OR company LIKE ? OR message LIKE ?)');
    const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
    args.push(like, like, like, like);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  try {
    const [[{ total }]] = await db.pool.query(`SELECT COUNT(*) AS total FROM enquiries ${whereSql}`, args);
    const [rows] = await db.pool.query(
      `SELECT id, name, email, company, topic, message, status, created_at FROM enquiries ${whereSql}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [...args, pageSize, (page - 1) * pageSize]);
    const [counts] = await db.pool.query('SELECT status, COUNT(*) AS n FROM enquiries GROUP BY status');
    res.set('Cache-Control', 'no-store');
    res.json({ rows, total, page, pageSize, counts: Object.fromEntries(counts.map(c => [c.status, c.n])), topics: TOPICS });
  } catch (err) {
    console.error('Failed to list enquiries:', err.message);
    res.status(500).json({ error: 'Could not load enquiries.' });
  }
});

// Change status
app.patch('/api/admin/enquiries/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const status = req.body && req.body.status;
  if (!id || !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid request.' });
  try {
    const [r] = await db.pool.execute('UPDATE enquiries SET status = ? WHERE id = ?', [status, id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Enquiry not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to update enquiry:', err.message);
    res.status(500).json({ error: 'Could not update the enquiry.' });
  }
});

// Delete
app.delete('/api/admin/enquiries/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid request.' });
  try {
    const [r] = await db.pool.execute('DELETE FROM enquiries WHERE id = ?', [id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Enquiry not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to delete enquiry:', err.message);
    res.status(500).json({ error: 'Could not delete the enquiry.' });
  }
});

// CSV export of everything
app.get('/api/admin/enquiries.csv', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.pool.query('SELECT id, created_at, status, name, email, company, topic, message FROM enquiries ORDER BY created_at DESC');
    const cell = v => {
      let s = v == null ? '' : (v instanceof Date ? v.toISOString() : String(v));
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const head = ['id', 'created_at', 'status', 'name', 'email', 'company', 'topic', 'message'];
    const csv = [head.join(',')].concat(rows.map(r => head.map(h => cell(r[h])).join(','))).join('\r\n');
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="shreedash-enquiries.csv"', 'Cache-Control': 'no-store' });
    res.send('﻿' + csv);
  } catch (err) {
    console.error('Failed to export enquiries:', err.message);
    res.status(500).send('Could not export enquiries.');
  }
});

app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'views', '404.html')));

db.init()
  .then(() => app.listen(PORT, () => console.log(`Shreedash site running on http://localhost:${PORT}  (admin: /admin)`)))
  .catch(err => {
    console.error('Could not connect to MySQL. Check DB_* settings in .env.\n', err.message);
    process.exit(1);
  });
