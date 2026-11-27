'use strict';
require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const db = require('./db');
const validate = require('./public/validate');

const {
  PORT = 3000,
  NODE_ENV = 'development',
  ADMIN_USERNAME = 'admin',
  ADMIN_PASSWORD_HASH = '',
  SESSION_SECRET = '',
  TRUST_PROXY = ''
} = process.env;
const isProd = NODE_ENV === 'production';
// Admin login from environment variables (optional). Without it, the admin account lives in MySQL
// and is created once through /admin/setup.
const envAdmin = ADMIN_PASSWORD_HASH.startsWith('$2');
// A real bcrypt hash used when the username is unknown, so every failed login takes the same time.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);

const TOPICS = [
  'Software development', 'IT staffing', 'Data engineering', 'AI applications',
  'e-Commerce and payments', 'Internship: Data Engineering',
  'Internship: Web Development', 'Internship: AI Applications'
];
const STATUSES = ['new', 'in_progress', 'closed'];

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, body) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · Shreedash</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.6 Manrope,system-ui,sans-serif;background:light-dark(#f3f5f7,#101418);color:light-dark(#101418,#eef1f4);padding:16px}main{max-width:520px;background:light-dark(#fff,#171d24);border:1px solid light-dark(#dde2e7,#2a323b);border-radius:16px;padding:32px}h1{font-size:26px;margin:0 0 10px}a{color:inherit}</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;

async function adminCount() {
  const [[{ n }]] = await db.pool.query('SELECT COUNT(*) AS n FROM admin_users');
  return Number(n);
}
async function needsSetup() {
  if (envAdmin || !db.state.ready) return false;
  return (await adminCount()) === 0;
}
async function verifyAdmin(username, password) {
  if (envAdmin) {
    const ok = await bcrypt.compare(password, ADMIN_PASSWORD_HASH).catch(() => false);
    return ok && username === ADMIN_USERNAME;
  }
  if (!db.state.ready) return false;
  const [rows] = await db.pool.execute('SELECT password_hash FROM admin_users WHERE username = ?', [username]);
  const ok = await bcrypt.compare(password, rows.length ? rows[0].password_hash : DUMMY_HASH).catch(() => false);
  return ok && rows.length > 0;
}
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

async function start() {
  const dbOk = await db.init();
  if (dbOk) console.log(`MySQL connected (${db.describe()}).`);
  else console.error(`MySQL is not connected (${db.describe()}): ${db.state.error}\nThe site will still run; the contact form and admin page need the database. Set DB_HOST, DB_USER, DB_PASSWORD and DB_NAME (or DATABASE_URL).`);

  // Session secret: environment variable if set, otherwise generated once and kept in MySQL.
  let secret = SESSION_SECRET;
  if (!secret || secret.length < 32) {
    if (dbOk) {
      secret = await db.getOrCreateSetting('session_secret', () => db.randomHex(32));
      console.log('SESSION_SECRET not set: using a generated secret stored in the database.');
    } else {
      secret = db.randomHex(32);
      console.warn('SESSION_SECRET not set and no database: using a temporary secret (admin sign-ins reset on restart).');
    }
  }

  if (await needsSetup()) {
    const code = await db.getOrCreateSetting('setup_code', () => db.randomHex(6));
    console.log('==============================================================');
    console.log(' No admin account yet. Open /admin/setup on your site and enter');
    console.log(` this one-time setup code: ${code}`);
    console.log('==============================================================');
  }

  // Keep trying to reach the database if it was not ready at start.
  if (!dbOk) {
    const retry = setInterval(async () => {
      if (await db.init()) { console.log('MySQL connected.'); clearInterval(retry); }
    }, 30000);
    retry.unref();
  }

  const app = express();
  if (TRUST_PROXY === '1' || (isProd && TRUST_PROXY !== '0')) app.set('trust proxy', 1);
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
        upgradeInsecureRequests: null
      }
    }
  }));

  app.use(express.json({ limit: '20kb' }));
  app.use(express.urlencoded({ extended: false, limit: '10kb' }));

  app.use(session({
    name: 'sd.sid',
    secret,
    store: dbOk ? new MySQLStore({ createDatabaseTable: true, clearExpired: true }, db.pool) : undefined,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: app.get('trust proxy') ? true : undefined,
    // 'auto' marks the cookie Secure whenever the visitor is on HTTPS, so login works behind any proxy.
    cookie: { httpOnly: true, sameSite: 'lax', secure: isProd ? 'auto' : false, maxAge: 1000 * 60 * 60 * 8 }
  }));

  app.get('/healthz', (req, res) => res.json({ ok: true, database: db.state.ready }));

  // ---------- Public site ----------
  app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: isProd ? '1h' : 0 }));

  const contactLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many messages from this address. Please try again in a few minutes.' } });

  const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

  app.post('/api/contact', contactLimiter, async (req, res) => {
    const body = req.body || {};
    // Honeypot: real visitors never fill this hidden field.
    if (body.website) return res.status(201).json({ ok: true });

    const name = clean(body.name, 120);
    const em = validate.email(body.email);
    const ph = validate.phone(body.phone);
    const company = clean(body.company, 190) || null;
    const topic = TOPICS.includes(body.topic) ? body.topic : 'Software development';
    const message = clean(body.message, 5000);

    const fields = {};
    if (!name) fields.name = 'Please enter your name.';
    if (!em.ok) fields.email = em.error;
    if (!ph.ok) fields.phone = ph.error;
    if (message.length < 2) fields.msg = 'Please tell us briefly how we can help.';
    if (Object.keys(fields).length) {
      return res.status(400).json({ error: Object.values(fields)[0], fields });
    }
    const email = em.value, phone = ph.value;
    if (!db.state.ready) return res.status(503).json({ error: 'We could not save your message just now. Please email us instead.' });
    try {
      await db.pool.execute(
        'INSERT INTO enquiries (name, email, phone, company, topic, message, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [name, email, phone, company, topic, message, req.ip || null, clean(req.get('user-agent'), 255) || null]
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
    if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Please sign in again.' });
    return res.redirect('/admin/login');
  };

  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, skipSuccessfulRequests: true });

  const noDatabasePage = () => page('Database not connected',
    '<p>The admin area needs the MySQL database, and the site cannot reach it yet.</p><p>Create a MySQL database for this app on your host and give the app its connection settings: <code>DB_HOST</code>, <code>DB_USER</code>, <code>DB_PASSWORD</code> and <code>DB_NAME</code> (or <code>DATABASE_URL</code>). The site retries every 30 seconds.</p><p><a href="/">Back to the website</a></p>');

  app.get('/admin/login', async (req, res, next) => {
    try {
      if (req.session.admin) return res.redirect('/admin');
      if (!envAdmin && !db.state.ready) return res.status(503).send(noDatabasePage());
      if (await needsSetup()) return res.redirect('/admin/setup');
      res.sendFile(path.join(__dirname, 'views', 'login.html'));
    } catch (err) { next(err); }
  });

  app.post('/admin/login', loginLimiter, async (req, res) => {
    const u = clean(req.body.username, 100);
    const p = typeof req.body.password === 'string' ? req.body.password : '';
    let ok = false;
    try { ok = await verifyAdmin(u, p); } catch (err) { console.error('Login check failed:', err.message); }
    if (!ok) return res.redirect('/admin/login?error=1');
    req.session.regenerate(err => {
      if (err) return res.redirect('/admin/login?error=1');
      req.session.admin = { username: u, at: Date.now() };
      req.session.save(() => res.redirect('/admin'));
    });
  });

  // First-run setup: create the admin account, protected by the one-time code printed in the server log.
  app.get('/admin/setup', async (req, res, next) => {
    try {
      if (!envAdmin && !db.state.ready) return res.status(503).send(noDatabasePage());
      if (!(await needsSetup())) return res.redirect('/admin/login');
      res.sendFile(path.join(__dirname, 'views', 'setup.html'));
    } catch (err) { next(err); }
  });

  app.post('/admin/setup', loginLimiter, async (req, res) => {
    try {
      if (!(await needsSetup())) return res.redirect('/admin/login');
      const code = clean(req.body.code, 64).toLowerCase();
      const username = clean(req.body.username, 100);
      const password = typeof req.body.password === 'string' ? req.body.password : '';
      const confirm = typeof req.body.confirm === 'string' ? req.body.confirm : '';
      const stored = await db.getSetting('setup_code');
      if (!stored || !safeEqual(code, stored)) return res.redirect('/admin/setup?error=code');
      if (!/^[A-Za-z0-9._@-]{3,100}$/.test(username)) return res.redirect('/admin/setup?error=username');
      if (password.length < 10 || password.length > 200) return res.redirect('/admin/setup?error=short');
      if (password !== confirm) return res.redirect('/admin/setup?error=match');
      const hash = await bcrypt.hash(password, 12);
      await db.pool.execute('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)', [username, hash]);
      await db.deleteSetting('setup_code');
      console.log(`Admin account "${username}" created through /admin/setup.`);
      req.session.regenerate(err => {
        if (err) return res.redirect('/admin/login');
        req.session.admin = { username, at: Date.now() };
        req.session.save(() => res.redirect('/admin'));
      });
    } catch (err) {
      console.error('Admin setup failed:', err.message);
      res.redirect('/admin/setup?error=server');
    }
  });

  app.post('/admin/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('sd.sid');
      res.redirect('/admin/login');
    });
  });

  // Admin data needs the database.
  app.use('/api/admin', (req, res, next) => db.state.ready ? next() : res.status(503).json({ error: 'The database is not connected.' }));

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
      where.push('(name LIKE ? OR email LIKE ? OR phone LIKE ? OR company LIKE ? OR message LIKE ?)');
      const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
      args.push(like, like, like, like, like);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    try {
      const [[{ total }]] = await db.pool.query(`SELECT COUNT(*) AS total FROM enquiries ${whereSql}`, args);
      const [rows] = await db.pool.query(
        `SELECT id, name, email, phone, company, topic, message, status, created_at FROM enquiries ${whereSql}
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
      const [rows] = await db.pool.query('SELECT id, created_at, status, name, email, phone, company, topic, message FROM enquiries ORDER BY created_at DESC');
      const cell = v => {
        let s = v == null ? '' : (v instanceof Date ? v.toISOString() : String(v));
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
        return '"' + s.replace(/"/g, '""') + '"';
      };
      const head = ['id', 'created_at', 'status', 'name', 'email', 'phone', 'company', 'topic', 'message'];
      const csv = [head.join(',')].concat(rows.map(r => head.map(h => cell(r[h])).join(','))).join('\r\n');
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="shreedash-enquiries.csv"', 'Cache-Control': 'no-store' });
      res.send('﻿' + csv);
    } catch (err) {
      console.error('Failed to export enquiries:', err.message);
      res.status(500).send('Could not export enquiries.');
    }
  });

  app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'views', '404.html')));
  app.use((err, req, res, next) => {
    console.error('Unexpected error:', err.message);
    res.status(500).send(page('Something went wrong', '<p>Please try again in a moment.</p><p><a href="/">Back to the website</a></p>'));
  });

  app.listen(PORT, () => console.log(`Shreedash site running on port ${PORT} (admin: /admin)`));
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
