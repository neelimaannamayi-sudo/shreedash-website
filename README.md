# Shreedash website

Marketing website for Shreedash (IT staffing, software development, data engineering, AI applications, e-commerce and payment gateway integration, internships), built with **Node.js + Express**. The Contact form saves enquiries to **MySQL**, and a login-protected **admin page** lists them.

## What's inside

| Path | What it is |
|---|---|
| `server.js` | Express server: website, `/api/contact`, admin login and admin APIs |
| `db.js` | MySQL connection pool; creates the `enquiries` table on start if missing |
| `public/index.html` | The website (all sections, styles and scripts in one file) |
| `views/login.html`, `views/admin.html` | Admin sign-in and enquiries dashboard |
| `db/schema.sql` | Database and table creation script |
| `scripts/hash-password.js` | Makes the bcrypt hash for the admin password |
| `.env.example` | All settings; copy to `.env` |

## Run it on Windows

1. Install **Node.js 18 or newer** and **MySQL 8** (or MariaDB).
2. Create the database (MySQL command line or Workbench):
   ```
   mysql -u root -p < db/schema.sql
   ```
   Optionally create a dedicated user (commented lines at the end of `schema.sql`).
3. In this folder:
   ```
   npm install
   copy .env.example .env
   npm run hash-password -- "YourStrongPassword"
   ```
4. Open `.env` and set `DB_USER`, `DB_PASSWORD`, paste the hash into `ADMIN_PASSWORD_HASH` (wrap it in single quotes), and set `SESSION_SECRET` to a long random string:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
5. Start it:
   ```
   npm start
   ```
   Website: http://localhost:3000 · Admin: http://localhost:3000/admin

## Admin page

- Sign in with `ADMIN_USERNAME` and the password you hashed.
- Filter by status (New, In progress, Closed) or topic, search by name, email, company or message.
- Change status, read the full message, reply by email, delete, or export everything to CSV.

## Security notes

- Passwords are checked with bcrypt; logins are rate limited (10 failed tries per 15 minutes per IP).
- Sessions are stored in MySQL (`sessions` table, created automatically), with `HttpOnly`, `SameSite=Strict` cookies, and `Secure` when `NODE_ENV=production`.
- All SQL uses parameterised queries. The contact form is rate limited and has a hidden honeypot field against spam bots.
- In production run behind HTTPS (e.g. Nginx or IIS reverse proxy), set `NODE_ENV=production` and `TRUST_PROXY=1`.

## Placeholders to replace

The email `hello@shreedash.example`, phone `+1 (555) 010-2040` and office address in `public/index.html` are placeholders.
