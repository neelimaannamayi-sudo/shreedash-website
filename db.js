'use strict';
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'shreedash',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'shreedash',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  timezone: 'Z'
});

// Creates the enquiries table if it is missing, so a fresh database works out of the box.
async function init() {
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
}

module.exports = { pool, init };
