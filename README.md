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

## Notes for Mobile Offline Use

- The app should be opened once while online so assets/cache are stored.
- After that, cached content can be opened offline.
- Pending uploads are queued and synced when the device comes back online.
