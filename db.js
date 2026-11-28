'use strict';
const crypto = require('crypto');
const mysql = require('mysql2/promise');

// Read the first environment variable that is set, so the app works with
// whatever names the host uses (DB_*, MYSQL_*, MYSQLHOST, DATABASE_URL ...).
const pick = (...names) => {
  for (const n of names) if (process.env[n]) return process.env[n];
  return undefined;
};

const url = pick('DATABASE_URL', 'MYSQL_URL', 'MYSQL_DATABASE_URL', 'DB_URL', 'JAWSDB_URL', 'CLEARDB_DATABASE_URL');
const common = { waitForConnections: true, connectionLimit: 10, charset: 'utf8mb4', timezone: 'Z', connectTimeout: 10000 };

const settings = url ? { uri: url, ...common } : {
  host: pick('DB_HOST', 'MYSQL_HOST', 'MYSQLHOST', 'DATABASE_HOST') || '127.0.0.1',
  port: Number(pick('DB_PORT', 'MYSQL_PORT', 'MYSQLPORT', 'DATABASE_PORT') || 3306),
  user: pick('DB_USER', 'DB_USERNAME', 'MYSQL_USER', 'MYSQLUSER', 'DATABASE_USER', 'DATABASE_USERNAME') || 'shreedash',
  password: pick('DB_PASSWORD', 'DB_PASS', 'MYSQL_PASSWORD', 'MYSQLPASSWORD', 'DATABASE_PASSWORD') || '',
  database: pick('DB_NAME', 'DB_DATABASE', 'MYSQL_DATABASE', 'MYSQLDATABASE', 'DATABASE_NAME') || 'shreedash',
  ...common
};

const pool = mysql.createPool(settings);
const state = { ready: false, error: null };

const describe = () => url ? 'connection URL' : `${settings.user}@${settings.host}:${settings.port}/${settings.database}`;

// Creates the tables the app needs if they are missing. Returns true when the database is usable.
async function init() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS enquiries (
      id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name        VARCHAR(120)  NOT NULL,
      email       VARCHAR(190)  NOT NULL,
      phone       VARCHAR(30)   NULL,
      company     VARCHAR(190)  NULL,
      topic       VARCHAR(80)   NOT NULL,
      message     TEXT          NOT NULL,
      status      ENUM('new','in_progress','closed') NOT NULL DEFAULT 'new',
      ip_address  VARCHAR(45)   NULL,
      user_agent  VARCHAR(255)  NULL,
      created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_status_created (status, created_at),
      INDEX idx_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    // Add the phone column to tables created before it existed.
    const [cols] = await pool.query("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'enquiries' AND COLUMN_NAME = 'phone'");
    if (!Number(cols[0].n)) await pool.query('ALTER TABLE enquiries ADD COLUMN phone VARCHAR(30) NULL AFTER email');
    const [cc] = await pool.query("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'enquiries' AND COLUMN_NAME = 'callback_consent'");
    if (!Number(cc[0].n)) await pool.query('ALTER TABLE enquiries ADD COLUMN callback_consent TINYINT(1) NOT NULL DEFAULT 0 AFTER message');
    // AI voice agent: phone callbacks and website voice chats, with transcripts.
    await pool.query(`CREATE TABLE IF NOT EXISTS voice_calls (
      id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      enquiry_id   INT UNSIGNED NULL,
      channel      ENUM('phone','web') NOT NULL DEFAULT 'phone',
      token        CHAR(32)     NOT NULL UNIQUE,
      phone        VARCHAR(20)  NULL,
      provider_sid VARCHAR(80)  NULL,
      status       VARCHAR(20)  NOT NULL DEFAULT 'queued',
      attempts     TINYINT UNSIGNED NOT NULL DEFAULT 0,
      due_at       TIMESTAMP    NULL,
      answered_at  TIMESTAMP    NULL,
      ended_at     TIMESTAMP    NULL,
      duration_sec INT UNSIGNED NULL,
      language     VARCHAR(8)   NULL,
      transcript   MEDIUMTEXT   NULL,
      summary      TEXT         NULL,
      error        VARCHAR(255) NULL,
      requested_by VARCHAR(45)  NULL,
      created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_status_due (status, due_at),
      INDEX idx_enquiry (enquiry_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await pool.query(`CREATE TABLE IF NOT EXISTS voice_optouts (
      phone      VARCHAR(20) NOT NULL PRIMARY KEY,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await pool.query(`CREATE TABLE IF NOT EXISTS app_settings (
      k VARCHAR(64) NOT NULL PRIMARY KEY,
      v TEXT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await pool.query(`CREATE TABLE IF NOT EXISTS admin_users (
      id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      username      VARCHAR(100) NOT NULL UNIQUE,
      password_hash VARCHAR(100) NOT NULL,
      created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    state.ready = true;
    state.error = null;
  } catch (err) {
    state.ready = false;
    state.error = err.message;
  }
  return state.ready;
}

// Returns a stored setting, creating it with make() the first time. Safe when several instances start at once.
async function getOrCreateSetting(key, make) {
  await pool.execute('INSERT IGNORE INTO app_settings (k, v) VALUES (?, ?)', [key, make()]);
  const [rows] = await pool.execute('SELECT v FROM app_settings WHERE k = ?', [key]);
  return rows[0].v;
}

async function getSetting(key) {
  const [rows] = await pool.execute('SELECT v FROM app_settings WHERE k = ?', [key]);
  return rows.length ? rows[0].v : null;
}

async function deleteSetting(key) {
  await pool.execute('DELETE FROM app_settings WHERE k = ?', [key]);
}

const randomHex = bytes => crypto.randomBytes(bytes).toString('hex');

module.exports = { pool, init, state, describe, getOrCreateSetting, getSetting, deleteSetting, randomHex };
