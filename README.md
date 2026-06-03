# Wawasan Candle OMS — Frontend

React + Vite single-page app for the Order Management System. It talks to the
[`oms-backend`](../oms-backend) REST API over HTTP using a JWT bearer token.

## Quick Start (local dev)

```bash
npm install
cp .env.example .env     # set VITE_API_URL (defaults to http://localhost:3001/api)
npm run dev              # http://localhost:5173
```

Make sure the backend is running (or the app falls back to a read-only demo mode
when it can't reach the API).

## Environment

| Variable       | Description                                              |
|----------------|----------------------------------------------------------|
| `VITE_API_URL` | Backend base URL **including** `/api`, no trailing slash |

- Local:  `http://localhost:3001/api`
- Prod:   `https://<your-backend>.vercel.app/api`

> Vite only exposes variables prefixed with `VITE_`, and they are inlined at
> **build time** — set `VITE_API_URL` in Vercel *before* deploying.

## Deploy to Vercel

1. Import the **wawasan-oms-frontend** GitHub repo as a Vercel project
   (Root Directory: repo root; framework auto-detects as Vite).
2. Add an Environment Variable `VITE_API_URL` = your deployed backend URL (+ `/api`).
3. Deploy. `vercel.json` builds with Vite and serves the SPA from `dist/`.
4. Add the resulting frontend URL to the backend's `FRONTEND_URL` (CORS allow-list).

## Build

```bash
npm run build    # outputs to dist/
npm run preview  # preview the production build locally
```

## Tech Stack
- React 19 + Vite
- Plain `fetch` API client (`src/App.jsx`), JWT stored in `localStorage`
