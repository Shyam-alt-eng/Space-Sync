# SpaceSync

SpaceSync is an offline-first, collection-based workspace for files and short messages.
It is designed for small teams, shared devices, or family/shared-tablet environments where people want one place to store files, leave notes, and sync activity across devices without losing access when the network drops.

The product idea is simple: instead of treating files and messages as separate tools, SpaceSync puts them in the same timeline for each collection. A collection can be thought of as a shared room or project folder. Inside that room, people can post messages, upload files, rename items, delete items, and review an audit trail of important actions.

## Why this project exists

SpaceSync exists to solve a real problem that many small collaborative spaces have:

- people need a shared place for both files and conversation
- devices are not always online
- more than one person may use the same app on different devices
- access should be controlled instead of assumed
- deleted work should be recoverable when possible
- the app should still feel usable on mobile and in unstable network conditions

This project combines those needs into one workflow: request access, get approved, join a collection, post messages, upload files, and keep working even when offline.

## What the app does

SpaceSync lets users:

- create collections for different topics, groups, or projects
- upload files into a specific collection
- rename files and collections
- write, edit, and delete messages
- work offline and queue uploads locally
- sync cached content when connectivity returns
- install the app as a PWA on supported devices
- request access for a device and wait for admin approval
- let admins manage devices, permissions, and audit records

## What happens at a high level

The app has two major parts:

- Client: the React app users interact with
- Server: the Express API, Socket.IO event layer, and MongoDB persistence

The client is responsible for rendering the interface, caching data locally, and handling offline behavior. The server is responsible for authentication decisions, file persistence, database operations, and broadcasting live updates to connected clients.

## How the product works step by step

### 1. A device opens the app

When the app opens, the client creates or reuses a stable device ID stored in localStorage. That device ID becomes the identity the backend uses to track requests, approvals, permissions, and audits.

In practice, this means the app recognizes the browser or device across refreshes without requiring a full account login flow.

### 2. The app checks whether access is approved

The client calls the access verification endpoint. The server looks up the device in MongoDB and returns one of several states:

- new: the device is unknown
- pending: the device requested access and is waiting
- approved: the device can use the app
- rejected: the device was blocked or revoked

If the database is still starting up, the server returns a loading response instead of pretending the device is invalid. That keeps the UI honest during cold starts.

### 3. A new user requests access

If the device is unknown, the user enters a device name and submits an access request. The server stores the request, marks the device as pending, and emits a live Socket.IO event so admins can see the request immediately.

This is the gatekeeping layer that keeps the app from behaving like an open public workspace.

### 4. An admin approves or rejects the request

Admins can open the admin dashboard and review devices. Approval changes the device status to approved and assigns permissions. Rejection marks the device as rejected.

The admin panel also supports changing permissions later. That gives you granular control over who can read, write, or delete content.

### 5. The approved user loads collections and content

Once approved, the client fetches collections, files, and notes from the server. The same data is also cached in IndexedDB so the app can show a local copy later if the network disappears.

### 6. The user works inside a collection

Inside a collection, the app combines three kinds of timeline items:

- notes
- files
- pending uploads

This is why the interface feels like one shared activity stream rather than separate pages for chat and files.

### 7. The app reacts live

The server emits events over Socket.IO whenever something changes:

- file created
- file renamed
- file deleted
- note created
- note updated
- note deleted
- access requested
- access approved
- access revoked
- collection deleted

The client listens for those events and updates the visible timeline without requiring a manual refresh.
In addition to realtime events, the client performs a silent background refresh every 5 seconds to keep data current without causing visible UI disruption.

### 8. Offline mode keeps the app usable

If the connection drops, the app still shows cached collections and files from IndexedDB. New uploads are queued locally instead of being lost. Once the device is back online, the user can continue working and the app can sync again.

The point is not just to display a disconnected badge. The point is to preserve work until the server can accept it.

### 9. Deleted work is tracked

Files and notes are soft deleted first. That means they are marked as deleted in the database rather than immediately removed forever. Admins can inspect audit logs and choose to restore or permanently remove items.

This gives the app a recovery path while still supporting cleanup.

## What the code is doing

### Client responsibilities

The client lives in client/src and is built with React + Vite.

Important responsibilities include:

- creating the app shell and lock screen in App.jsx
- storing cached collections, files, and queued uploads in db.js
- connecting to the server through axios and Socket.IO
- rendering the collection timeline and admin panel
- tracking online/offline status
- keeping the UI responsive on desktop and mobile

The IndexedDB layer stores:

- collections cache
- files cache
- pending upload queue

That local cache is what lets the app reopen with meaningful content even when the API is unreachable.

### Server responsibilities

The server lives in server/index.js and handles the platform logic.

Important responsibilities include:

- connection to MongoDB
- device verification and admin access
- permission enforcement for read, write, and delete actions
- collection CRUD
- file upload, rename, soft delete, and permanent delete
- note CRUD and note audit history
- admin tooling for device management and audit recovery
- serving uploaded files and the production client build
- broadcasting realtime changes through Socket.IO

## Data model overview

The backend stores four main kinds of documents.

### Device

Device records represent a browser or device identity. They store:

- deviceId
- name
- status
- isAdmin
- permissions

This is how SpaceSync knows who can do what without a traditional username/password login flow.

### Collection

Collections are the top-level containers. They store:

- name
- description
- timestamps

Collections are the organizational boundary for files and notes.

### File

File records track uploaded files and their metadata:

- original name
- stored name on disk
- display name
- MIME type
- size
- upload path
- uploader identity
- soft delete state

### Note

Notes represent short text messages. They store:

- collection reference
- message text
- creator identity
- edit timestamp
- soft delete state

### AuditLog

Audit logs record important actions such as file uploads, note creation, note edits, and deletions. This is what makes the admin recovery tools meaningful.

## Why the architecture is shaped this way

This app is intentionally split into a reactive client and a stateful backend because the behavior it needs is not just CRUD.

We need:

- real-time updates for multiple devices
- local persistence for offline mode
- controlled permissions for shared usage
- auditability for recovery and administration
- file storage with visible download links

If this were built as a plain stateless CRUD app, offline support and access control would be much weaker and the experience would degrade quickly on mobile or unreliable networks.

## Why someone should use SpaceSync

Someone should use this application if they want:

- a shared workspace that combines files and messages in one place
- a lightweight alternative to a full chat + drive stack
- offline support for real-world interruptions
- access approval instead of open anonymous usage
- admin controls for device-level permissions
- a PWA experience that feels app-like on mobile

In other words, SpaceSync is useful when a team wants a practical shared room for collaboration without the complexity of a full enterprise suite.

## Development setup

### Prerequisites

- Node.js 18+
- npm
- MongoDB locally or a MongoDB Atlas connection string

### Install dependencies

Run this from the project root:

```bash
npm --prefix server install
npm --prefix client install
```

### Run in development

Open two terminals from the project root:

```bash
npm --prefix server run dev
```

```bash
npm --prefix client run dev
```

Then open:

- Client: http://localhost:5173
- Server: http://localhost:5000

## Build and deploy

### Single-service deployment

The recommended deployment model is a single Node service where Express serves the built React app.

Build command:

```bash
cd server && npm install && cd ../client && npm install && npm run build
```

Start command:

```bash
cd server && npm start
```

Environment variables:

```bash
NODE_ENV=production
MONGO_URI=<your mongodb uri>
CLIENT_ORIGIN=<your deployed app origin>
```

### Split deployment

You can also deploy the frontend and backend separately.

- Backend: deploy server/ to Render or Railway
- Frontend: deploy client/ to Vercel or Netlify

For split deployment:

```bash
VITE_API_URL=https://your-backend-domain.com
CLIENT_ORIGIN=https://your-frontend-domain.com
```

## Real-world behavior notes

- The app should be opened once while online so the client can cache assets and data.
- Cached collections and files allow the UI to reopen in a useful state when the network is unavailable.
- Pending uploads are stored locally until a reconnect flow is used to send them to the server.
- Socket.IO keeps the UI synchronized when multiple approved devices are active at the same time.
- A silent 5-second background refresh loop keeps collections and timeline data fresh without flashing or interrupting the interface.

## Security and operations notes

- Device access is controlled through server-side middleware, not only the UI.
- File uploads are stored on disk and served from the backend.
- Audit logs exist so admin actions can be explained later.
- Production deployments should always set a strong ADMIN_SECRET.
- Uploaded user files should not be treated as source files or checked into git.

## Project structure

```text
client/   React app, PWA, IndexedDB cache, Socket.IO client
server/   Express API, MongoDB models, file uploads, Socket.IO server
```

## In short

SpaceSync is a shared workspace for collections of files and notes with offline support, live sync, and admin-controlled access.
It exists to make collaborative file and message workflows usable in real conditions, not just in a perfect always-online demo.
