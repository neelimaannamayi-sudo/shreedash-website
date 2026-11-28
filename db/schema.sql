-- Shreedash website database
-- Run once as a MySQL admin user:  mysql -u root -p < db/schema.sql
CREATE DATABASE IF NOT EXISTS shreedash CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE shreedash;

CREATE TABLE IF NOT EXISTS enquiries (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(120)  NOT NULL,
  email       VARCHAR(190)  NOT NULL,
  phone       VARCHAR(30)   NULL,
  company     VARCHAR(190)  NULL,
  topic       VARCHAR(80)   NOT NULL,
  message     TEXT          NOT NULL,
  callback_consent TINYINT(1) NOT NULL DEFAULT 0,
  status      ENUM('new','in_progress','closed') NOT NULL DEFAULT 'new',
  ip_address  VARCHAR(45)   NULL,
  user_agent  VARCHAR(255)  NULL,
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_status_created (status, created_at),
  INDEX idx_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- AI voice agent (phone callbacks through Exotel, website voice chats). The app also creates these on start.
CREATE TABLE IF NOT EXISTS voice_calls (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS voice_optouts (
  phone      VARCHAR(20) NOT NULL PRIMARY KEY,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Optional: a dedicated app user with only the rights it needs
-- CREATE USER IF NOT EXISTS 'shreedash'@'localhost' IDENTIFIED BY 'change-me';
-- GRANT SELECT, INSERT, UPDATE, DELETE, CREATE ON shreedash.* TO 'shreedash'@'localhost';
-- FLUSH PRIVILEGES;
