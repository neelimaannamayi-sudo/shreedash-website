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
