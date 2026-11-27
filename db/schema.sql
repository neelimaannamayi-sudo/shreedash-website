-- Shreedash website database
-- Run once as a MySQL admin user:  mysql -u root -p < db/schema.sql
CREATE DATABASE IF NOT EXISTS shreedash CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE shreedash;

CREATE TABLE IF NOT EXISTS enquiries (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Optional: a dedicated app user with only the rights it needs
-- CREATE USER IF NOT EXISTS 'shreedash'@'localhost' IDENTIFIED BY 'change-me';
-- GRANT SELECT, INSERT, UPDATE, DELETE, CREATE ON shreedash.* TO 'shreedash'@'localhost';
-- FLUSH PRIVILEGES;
