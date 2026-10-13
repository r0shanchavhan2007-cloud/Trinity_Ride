# Trinity Ride — Campus Rideshare Project

Trinity Academy College of Engineering, Pune — student-only rideshare app.

## Folder structure

- `frontend/trinity-ride-app.html` — the app prototype. Open directly in a browser, no server needed. Runs on mock/local data.
- `backend/` — Node/Express API (auth, rides, QR scan-to-start). See `backend/README.md` for setup.
- `database/trinity_ride_schema.sql` — MySQL schema + views for current/completed/cancelled rides. Run this before starting the backend.
- `docs/project-roadmap.html` — phased project plan, dependencies and risks.

## Quick start

1. Install MySQL, then: `mysql -u root -p < database/trinity_ride_schema.sql`
2. `cd backend && npm install && cp .env.example .env` — fill in `.env`, then `npm run dev`
3. Open `frontend/trinity-ride-app.html` in a browser to try the UI.

The frontend and backend are not wired together yet — the frontend currently runs on its own mock data for demo purposes.
