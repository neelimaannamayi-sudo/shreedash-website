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

## Deploying to a host (GoDaddy and others)

The site starts even when the host passes no settings:

- **Database:** reads `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, or the common alternatives (`MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, `MYSQLHOST`..., or a single `DATABASE_URL` / `MYSQL_URL` like `mysql://user:pass@host:3306/db`). Tables are created automatically. If the database can't be reached, the website still runs, the contact form asks visitors to email instead, and the server retries every 30 seconds.
- **Session secret:** if `SESSION_SECRET` isn't set, one is generated and stored in the database.
- **Admin login:** if `ADMIN_PASSWORD_HASH` isn't set, the first visit to `/admin` opens a one-time setup page. Enter the setup code printed in the server log (look for "one-time setup code"), then choose a username and password. The account is stored (hashed) in the database and the setup page disappears.
- `GET /healthz` returns `{"ok":true,"database":true|false}` for health checks.

## AI voice agent

Two parts, both using **Sarvam AI** for listening (saaras), thinking (sarvam-105b) and a natural Indian voice (bulbul):

1. **AI callback.** When a visitor sends the contact form with "Call me back" ticked, the agent (default name "Asha") phones them through **Exotel** about a minute later. It greets them by name, refers to their message, answers questions about Shreedash, asks about their needs, and says goodbye. The caller can interrupt at any time and can speak English, Hindi, Telugu, Tamil and other Indian languages. The transcript and a short summary appear in the admin page under **Read**, and the enquiry moves to *In progress*. You can also press **AI call** on any enquiry.
2. **"Talk to us" button** on the website. Visitors talk to the same agent in the browser (or type). Needs only the Sarvam key. The microphone works on `https://` sites and on `http://localhost`.

Calls only go out inside `VOICE_CALL_HOURS` (default 9 am to 8 pm IST); enquiries outside those hours are called when the hours start. No answer or busy: one retry after 30 minutes. If someone says "don't call me", their number is never called again.

### Set up

1. **Sarvam:** sign up at dashboard.sarvam.ai, create an API key, put it in `SARVAM_API_KEY`.
2. **Exotel:** open an Exotel account, finish KYC, and buy one ExoPhone (Indian virtual number). Ask Exotel support to enable **AgentStream / Voicebot (bidirectional streaming)** on the account. From Settings > API copy the Account SID, API key and API token into `EXOTEL_ACCOUNT_SID`, `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN`, and the ExoPhone into `EXOTEL_CALLER_ID`.
3. Set `PUBLIC_BASE_URL` to the site's public `https://` address. Exotel opens a secure WebSocket to `wss://<your site>/voice/exotel/stream` during the call, so the host must run Node.js all the time and allow WebSockets (a VPS, Render, Railway, or GoDaddy VPS; GoDaddy *shared* cPanel hosting usually does not keep WebSockets open).
4. Restart. The log shows `Website assistant: on. Phone callbacks: on.`

To test calls from your own computer, run the site and expose it with a tunnel such as `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`, then use the tunnel's https address as `PUBLIC_BASE_URL`.

| Path | What it is |
|---|---|
| `lib/voice.js` | Call queue, Exotel webhooks, live-call WebSocket, website assistant API, admin call APIs |
| `lib/phone-session.js` | One live call: detects when the caller stops talking, handles interruptions, plays replies |
| `lib/voice-agent.js` | The agent's persona, company knowledge and call summaries (edit facts here) |
| `lib/sarvam.js`, `lib/exotel.js` | Small API clients |
| `public/voice-assistant.js` | The "Talk to us" widget |

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
