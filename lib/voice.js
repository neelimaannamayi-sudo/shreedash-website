'use strict';
// Wires the voice agent into the website: queues AI callbacks for enquiries, places them through
// Exotel at sensible hours, runs the live call WebSocket, and serves the website "Talk to us" assistant.
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const db = require('../db');
const sarvam = require('./sarvam');
const exotel = require('./exotel');
const agent = require('./voice-agent');
const PhoneSession = require('./phone-session');

const env = (k, d) => (process.env[k] && process.env[k].trim()) || d;
const log = msg => console.log('[voice] ' + msg);

const publicBase = () => env('PUBLIC_BASE_URL', '').replace(/\/+$/, '');
const phoneEnabled = () => env('VOICE_CALLBACKS', 'on') !== 'off' && sarvam.enabled() && exotel.enabled() && /^https:\/\//.test(publicBase());
const webEnabled = () => env('VOICE_WEB_ASSISTANT', 'on') !== 'off' && sarvam.enabled();

// Calls only inside these local hours (TRAI allows commercial calls 9 am to 9 pm).
function withinCallingHours(date = new Date()) {
  const [from, to] = env('VOICE_CALL_HOURS', '9-20').split('-').map(Number);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: env('VOICE_TIMEZONE', 'Asia/Kolkata'), hour: 'numeric', hourCycle: 'h23' }).format(date));
  return hour >= from && hour < to;
}

const E164 = phone => {
  const d = String(phone || '').replace(/[^0-9+]/g, '');
  if (/^\+\d{8,15}$/.test(d)) return d;
  if (/^[6-9]\d{9}$/.test(d)) return '+91' + d;
  if (/^0[6-9]\d{9}$/.test(d)) return '+91' + d.slice(1);
  if (/^91[6-9]\d{9}$/.test(d)) return '+' + d;
  return null;
};

// ---------- Queue ----------
async function queueCallback(enquiryId, { delaySeconds, by = 'form' } = {}) {
  if (!db.state.ready) throw new Error('The database is not connected.');
  const [[e]] = await db.pool.query('SELECT id, phone FROM enquiries WHERE id = ?', [enquiryId]);
  if (!e) throw new Error('Enquiry not found.');
  const to = E164(e.phone);
  if (!to) throw new Error('This enquiry has no valid mobile number.');
  const [[opt]] = await db.pool.query('SELECT COUNT(*) AS n FROM voice_optouts WHERE phone = ?', [to]);
  if (Number(opt.n)) throw new Error('This number asked not to be called.');
  const [[active]] = await db.pool.query("SELECT COUNT(*) AS n FROM voice_calls WHERE enquiry_id = ? AND status IN ('queued','dialing','in_progress')", [enquiryId]);
  if (Number(active.n)) throw new Error('A call for this enquiry is already queued or running.');
  const delay = delaySeconds != null ? delaySeconds : Number(env('VOICE_CALLBACK_DELAY_SECONDS', '60'));
  const token = crypto.randomBytes(16).toString('hex');
  await db.pool.execute(
    "INSERT INTO voice_calls (enquiry_id, channel, token, phone, status, due_at, requested_by) VALUES (?, 'phone', ?, ?, 'queued', DATE_ADD(NOW(), INTERVAL ? SECOND), ?)",
    [enquiryId, token, to, delay, by]);
  if (!phoneEnabled()) log(`Callback queued for enquiry ${enquiryId}, but phone calls are not configured yet (EXOTEL_* / SARVAM_API_KEY / PUBLIC_BASE_URL).`);
  setTimeout(runQueue, delay * 1000 + 500).unref();
}

const greetings = new Map(); // token -> pre-rendered greeting audio, so the caller hears us instantly

let running = false;
async function runQueue() {
  if (running || !db.state.ready || !phoneEnabled() || !withinCallingHours()) return;
  running = true;
  try {
    const [due] = await db.pool.query(
      "SELECT c.id, c.token, c.phone, c.attempts, e.name, e.topic, e.company, e.message FROM voice_calls c JOIN enquiries e ON e.id = c.enquiry_id WHERE c.status = 'queued' AND c.due_at <= NOW() ORDER BY c.due_at LIMIT 5");
    for (const c of due) await dial(c);
  } catch (err) { log('Queue error: ' + err.message); }
  finally { running = false; }
}

async function dial(c) {
  const [r] = await db.pool.execute("UPDATE voice_calls SET status = 'dialing', attempts = attempts + 1 WHERE id = ? AND status = 'queued'", [c.id]);
  if (!r.affectedRows) return;
  try {
    const enquiry = { name: c.name, topic: c.topic, company: c.company, message: c.message };
    try {
      const wav = await sarvam.textToSpeech(agent.greeting({ channel: 'phone', enquiry }), 'en-IN', 8000);
      greetings.set(c.token, sarvam.wavToPcm(wav));
      setTimeout(() => greetings.delete(c.token), 10 * 60 * 1000).unref();
    } catch (err) { log('Could not pre-render greeting: ' + err.message); }
    const wss = publicBase().replace(/^http/, 'ws') + `/voice/exotel/stream?t=${c.token}&sample-rate=8000`;
    const out = await exotel.startCall({ to: c.phone, streamUrl: wss,
      statusUrl: publicBase() + `/voice/exotel/status?t=${c.token}`, customField: 'shreedash-' + c.id,
      timeLimit: Number(env('VOICE_MAX_CALL_SECONDS', '600')) + 60 });
    await db.pool.execute('UPDATE voice_calls SET provider_sid = ? WHERE id = ?', [out.sid || null, c.id]);
    log(`Calling ${c.phone.slice(0, -4)}xxxx for call ${c.id} (Exotel ${out.sid}).`);
  } catch (err) {
    log(`Dial failed for call ${c.id}: ${err.message}`);
    await db.pool.execute("UPDATE voice_calls SET status = 'failed', error = ? WHERE id = ?", [err.message.slice(0, 255), c.id]);
  }
}

// No answer or busy: try again later, a limited number of times.
async function retryOrClose(id, status) {
  const [[c]] = await db.pool.query('SELECT attempts FROM voice_calls WHERE id = ?', [id]);
  const max = Number(env('VOICE_MAX_ATTEMPTS', '2'));
  if (c && c.attempts < max) {
    await db.pool.execute("UPDATE voice_calls SET status = 'queued', due_at = DATE_ADD(NOW(), INTERVAL ? MINUTE), error = ? WHERE id = ?",
      [Number(env('VOICE_RETRY_MINUTES', '30')), status, id]);
  } else {
    await db.pool.execute('UPDATE voice_calls SET status = ? WHERE id = ?', [status, id]);
  }
}

async function finishCall(id, { history, language, optOut }) {
  const [[c]] = await db.pool.query('SELECT phone FROM voice_calls WHERE id = ?', [id]);
  const spoke = history.some(t => t.role === 'user');
  let summary = '';
  if (spoke) { try { summary = await agent.summarise(history); } catch (err) { log('Summary failed: ' + err.message); } }
  await db.pool.execute("UPDATE voice_calls SET status = ?, transcript = ?, language = ?, summary = ?, ended_at = NOW() WHERE id = ?",
    [spoke ? 'completed' : 'no_reply', JSON.stringify(history), language, summary || null, id]);
  if (optOut && c) await db.pool.execute('INSERT IGNORE INTO voice_optouts (phone) VALUES (?)', [c.phone]);
  // A real conversation happened, so the enquiry is being worked on.
  if (spoke) await db.pool.execute("UPDATE enquiries e JOIN voice_calls c ON c.enquiry_id = e.id SET e.status = 'in_progress' WHERE c.id = ? AND e.status = 'new'", [id]);
}

// ---------- Live call WebSocket ----------
function attach(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/voice/exotel/stream') return socket.destroy();
    const token = url.searchParams.get('t') || '';
    let call = null;
    try {
      if (/^[a-f0-9]{32}$/.test(token) && db.state.ready) {
        const [[c]] = await db.pool.query(
          "SELECT c.id, c.status, e.name, e.topic, e.company, e.message FROM voice_calls c JOIN enquiries e ON e.id = c.enquiry_id WHERE c.token = ? AND c.status IN ('dialing','in_progress')", [token]);
        call = c || null;
      }
    } catch (err) { log('Stream lookup failed: ' + err.message); }
    if (!call) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, ws => startSession(ws, call, token, Number(url.searchParams.get('sample-rate')) || 8000));
  });
}

function startSession(ws, call, token, sampleRate) {
  log(`Call ${call.id} connected.`);
  db.pool.execute("UPDATE voice_calls SET status = 'in_progress', answered_at = NOW() WHERE id = ?", [call.id]).catch(() => {});
  let saveTimer;
  new PhoneSession({
    ws, sampleRate,
    call: { enquiry: { name: call.name, topic: call.topic, company: call.company, message: call.message }, greetingPcm: sampleRate === 8000 ? greetings.get(token) : null },
    log: m => log(`Call ${call.id}: ${m}`),
    hangup: sid => exotel.hangup(sid),
    onStart: sid => { if (sid) db.pool.execute('UPDATE voice_calls SET provider_sid = COALESCE(provider_sid, ?) WHERE id = ?', [sid, call.id]).catch(() => {}); },
    onTranscript: (history, language) => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => db.pool.execute('UPDATE voice_calls SET transcript = ?, language = ? WHERE id = ?', [JSON.stringify(history), language, call.id]).catch(() => {}), 300);
    },
    onEnd: result => {
      clearTimeout(saveTimer);
      greetings.delete(token);
      log(`Call ${call.id} ended (${result.reason}).`);
      finishCall(call.id, result).catch(err => log('Saving call failed: ' + err.message));
    }
  });
}

// ---------- Express routes ----------
function routes(app, { express, rateLimit, requireAdmin }) {
  app.get('/api/voice/config', (req, res) => res.json({ web: webEnabled(), callbacks: phoneEnabled(), agent: agent.AGENT_NAME() }));

  // Exotel call status updates.
  app.post('/voice/exotel/status', async (req, res) => {
    res.status(200).end();
    const token = String(req.query.t || '');
    if (!/^[a-f0-9]{32}$/.test(token) || !db.state.ready) return;
    const b = req.body || {};
    const status = String(b.Status || b.CallStatus || b.status || '').toLowerCase();
    try {
      const [[c]] = await db.pool.query('SELECT id, status FROM voice_calls WHERE token = ?', [token]);
      if (!c) return;
      const dur = parseInt(b.ConversationDuration || b.Duration || b.duration, 10);
      if (dur >= 0) await db.pool.execute('UPDATE voice_calls SET duration_sec = ? WHERE id = ?', [dur, c.id]);
      if (['no-answer', 'busy', 'failed', 'canceled'].includes(status) && ['dialing', 'queued'].includes(c.status)) {
        await retryOrClose(c.id, status.replace('-', '_'));
      }
    } catch (err) { log('Status update failed: ' + err.message); }
  });

  // Website voice assistant: one spoken turn per request.
  const sessions = new Map();
  const webLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Lots of questions! Please wait a few minutes, or send us a message instead.' } });
  setInterval(() => { const cut = Date.now() - 30 * 60 * 1000; for (const [k, s] of sessions) if (s.at < cut) sessions.delete(k); }, 60000).unref();

  app.post('/api/voice/web', webLimiter, express.json({ limit: '1500kb' }), async (req, res) => {
    if (!webEnabled()) return res.status(503).json({ error: 'The voice assistant is not available right now.' });
    const b = req.body || {};
    let s = typeof b.session === 'string' && sessions.get(b.session);
    try {
      if (!s) {
        if (sessions.size > 2000) return res.status(503).json({ error: 'The assistant is busy. Please try again shortly.' });
        const id = crypto.randomBytes(16).toString('hex');
        s = { id, history: [], language: 'en-IN', at: Date.now(), dbId: null };
        sessions.set(id, s);
        const text = agent.greeting({ channel: 'web' });
        s.history.push({ role: 'assistant', content: text });
        const audio = await sarvam.textToSpeech(text, 'en-IN', 24000, 'mp3');
        return res.json({ session: id, reply: text, audio: audio.toString('base64'), mime: 'audio/mpeg' });
      }
      s.at = Date.now();
      if (s.history.length > 60) return res.json({ session: s.id, reply: 'We have covered a lot! Please send us a message with the contact form and our team will follow up.', end: true });
      let said = typeof b.text === 'string' ? b.text.trim().slice(0, 500) : '';
      if (!said && typeof b.audio === 'string') {
        const buf = Buffer.from(b.audio, 'base64');
        if (buf.length < 1000) return res.json({ session: s.id, heard: '', reply: '' });
        const mime = /^audio\/[a-z0-9.+-]+(;.*)?$/i.test(b.mime || '') ? b.mime : 'audio/webm';
        const heard = await sarvam.speechToText(buf, mime);
        said = heard.transcript;
        if (heard.language) s.language = heard.language;
      }
      if (!said) return res.json({ session: s.id, heard: '', reply: '' });
      s.history.push({ role: 'user', content: said });
      const r = await agent.reply({ channel: 'web', history: s.history });
      s.history.push({ role: 'assistant', content: r.text });
      const audio = await sarvam.textToSpeech(r.text, s.language, 24000, 'mp3');
      saveWeb(s, req).catch(err => log('Saving web chat failed: ' + err.message));
      res.json({ session: s.id, heard: said, reply: r.text, audio: audio.toString('base64'), mime: 'audio/mpeg', end: r.end });
    } catch (err) {
      log('Web assistant error: ' + err.message);
      res.status(502).json({ error: 'Sorry, I could not answer just now. Please try again.' });
    }
  });

  // ---- Admin ----
  app.get('/api/admin/enquiries/:id/calls', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      const [rows] = await db.pool.query('SELECT id, status, attempts, language, summary, transcript, duration_sec, error, due_at, answered_at, ended_at, created_at FROM voice_calls WHERE enquiry_id = ? ORDER BY id DESC', [id]);
      res.set('Cache-Control', 'no-store');
      res.json({ rows: rows.map(r => ({ ...r, transcript: r.transcript ? JSON.parse(r.transcript) : [] })), enabled: phoneEnabled(), withinHours: withinCallingHours() });
    } catch (err) { res.status(500).json({ error: 'Could not load calls.' }); }
  });

  app.post('/api/admin/enquiries/:id/call', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!phoneEnabled()) return res.status(400).json({ error: 'Phone calls are not set up yet. Add the Exotel and Sarvam settings to .env.' });
    try {
      await queueCallback(id, { delaySeconds: 0, by: 'admin' });
      res.json({ ok: true, note: withinCallingHours() ? 'Calling now.' : 'Outside calling hours: the call will go out when calling hours start.' });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.delete('/api/admin/calls/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      await db.pool.execute("UPDATE voice_calls SET status = 'cancelled' WHERE id = ? AND status = 'queued'", [id]);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: 'Could not cancel the call.' }); }
  });
}

async function saveWeb(s, req) {
  if (!db.state.ready) return;
  const json = JSON.stringify(s.history);
  if (s.dbId) return db.pool.execute('UPDATE voice_calls SET transcript = ?, language = ? WHERE id = ?', [json, s.language, s.dbId]);
  const [r] = await db.pool.execute("INSERT INTO voice_calls (channel, token, status, transcript, language, requested_by) VALUES ('web', ?, 'completed', ?, ?, ?)",
    [s.id, json, s.language, (req.ip || '').slice(0, 45)]);
  s.dbId = r.insertId;
}

function start() {
  setInterval(runQueue, 30000).unref();
  // Calls that were mid-dial when the server restarted.
  if (db.state.ready) db.pool.query("UPDATE voice_calls SET status = 'failed', error = 'server restarted' WHERE status IN ('dialing','in_progress') AND updated_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE)").catch(() => {});
  log(`Website assistant: ${webEnabled() ? 'on' : 'off (needs SARVAM_API_KEY)'}. Phone callbacks: ${phoneEnabled() ? 'on' : 'off (needs SARVAM_API_KEY, EXOTEL_* and an https PUBLIC_BASE_URL)'}.`);
}

module.exports = { attach, routes, start, queueCallback, phoneEnabled, webEnabled, withinCallingHours, E164 };
