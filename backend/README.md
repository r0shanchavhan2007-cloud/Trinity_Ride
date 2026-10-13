# Trinity Ride — Backend API (prototype)

Node/Express API that connects the frontend prototype to the MySQL schema
(`trinity_ride_schema.sql`, shared earlier). This is runnable on your own
machine or a host like Render/Railway — it can't run inside this chat.

## Setup

1. Install [Node.js](https://nodejs.org) (v18+) and [MySQL](https://dev.mysql.com/downloads/).
2. Load the schema:
   ```
   mysql -u root -p < trinity_ride_schema.sql
   ```
3. In this folder:
   ```
   npm install
   cp .env.example .env
   ```
   Fill in `.env` — at minimum `DB_PASSWORD` and a random `JWT_SECRET`.
4. Run it:
   ```
   npm run dev
   ```
   The API starts on `http://localhost:4000`. Check `GET /api/health`.

## Endpoints

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/auth/register` | Create account (college email only), sends OTP |
| POST | `/api/auth/verify-otp` | Confirm OTP, returns JWT |
| POST | `/api/auth/login` | Log in, returns JWT |
| GET  | `/api/rides/nearby-drivers` | List available student drivers |
| POST | `/api/rides/request` | Get a fare estimate for a pickup/drop |
| POST | `/api/rides/confirm` | Lock in a driver for a request |
| POST | `/api/qr/generate` | Issue the rider's short-lived scan code |
| POST | `/api/qr/scan` | Driver scans rider's code → starts the ride |
| POST | `/api/rides/:id/ping` | Driver posts a live location point |
| POST | `/api/rides/:id/end` | Mark a ride completed |

All routes except `/register`, `/verify-otp`, `/login` require
`Authorization: Bearer <token>` from login/verify-otp.

## What's still stubbed

- **Nearby drivers** returns all registered vehicles, not ones actually close
  by — wire it to the latest row per driver in `location_pings` once drivers'
  apps are sending live GPS.
- **OTP store** is in-memory — fine for a pilot, move to Redis or a DB table
  before running more than one server instance.
- **SMTP** is optional — without it, OTP codes print to the server console
  so you can test the flow locally without an email account.
