# SpaceSync

SpaceSync is a collection-based file and message workspace.

- Create collections (like chat sections)
- Upload files per collection
- Rename and delete files
- Add/edit/delete text messages
- Offline-first behavior with local cache and pending upload queue
- PWA support for installable mobile/web experience

## Tech Stack

- Client: React + Vite
- Server: Node.js + Express + Socket.IO
- Database: MongoDB
- Local offline storage: IndexedDB (`idb`)

## Project Structure

```text
client/   # React app (Vite)
server/   # Node/Express API + Socket.IO
```

## Prerequisites

- Node.js 18+
- npm
- MongoDB running locally or an Atlas connection string

## Install Dependencies

Run from project root:

```bash
npm --prefix server install
npm --prefix client install
```

## Start Servers (Development)

Open two terminals from project root.

Terminal 1 (backend):

```bash
npm --prefix server run dev
```

Terminal 2 (frontend):

```bash
npm --prefix client run dev
```

Then open:

- Client: http://localhost:5173
- Server: http://localhost:5000

## Stop Servers

In each running terminal:

```bash
Ctrl + C
```

If a port is still occupied on Windows, run:

exit the vs code by deleting all the terminal and reopen it.

## Build Client

```bash
npm --prefix client run build
```

## Deploy (Recommended: Render, Single Service)

This project is ready to run as one Node service where Express serves the built React app.

1. Push this repo to GitHub.
2. Create a new **Web Service** on Render.
3. Use these commands:

```bash
# Build Command
cd server && npm install && cd ../client && npm install && npm run build

# Start Command
cd server && npm start
```

4. Set environment variables in Render:

```bash
NODE_ENV=production
MONGO_URI=<your mongodb uri>
CLIENT_ORIGIN=<your render app url>
```

Notes:
- `PORT` is set automatically by Render.
- Frontend API defaults to same-origin in production, so no `VITE_API_URL` is required in single-service deploy.

## Deploy (Alternative: Split Frontend + Backend)

- Backend: deploy `server/` to Render/Railway.
- Frontend: deploy `client/` to Vercel/Netlify.

For split deploy, set:

```bash
# frontend environment variable
VITE_API_URL=https://your-backend-domain.com

# backend environment variable
CLIENT_ORIGIN=https://your-frontend-domain.com
```

## Notes for Mobile Offline Use

- The app should be opened once while online so assets/cache are stored.
- After that, cached content can be opened offline.
- Pending uploads are queued and synced when the device comes back online.
