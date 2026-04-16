import { openDB } from "idb";

const DB_NAME = "spacesync-db";
const DB_VERSION = 3;
const COLLECTIONS_STORE = "collections";
const FILES_STORE = "files";
const PENDING_STORE = "pendingUploads";

export const dbPromise = openDB(DB_NAME, DB_VERSION, {
  upgrade(db) {
    if (!db.objectStoreNames.contains(COLLECTIONS_STORE)) {
      db.createObjectStore(COLLECTIONS_STORE, { keyPath: "_id" });
    }
    if (!db.objectStoreNames.contains(FILES_STORE)) {
      db.createObjectStore(FILES_STORE, { keyPath: "_id" });
    }
    if (!db.objectStoreNames.contains(PENDING_STORE)) {
      db.createObjectStore(PENDING_STORE, { keyPath: "id" });
    }
  },
});

// Collections
export async function cacheCollections(collections) {
  const db = await dbPromise;
  const tx = db.transaction(COLLECTIONS_STORE, "readwrite");
  await tx.store.clear();
  for (const col of collections) {
    await tx.store.put(col);
  }
  await tx.done;
}

export async function getCachedCollections() {
  const db = await dbPromise;
  return db.getAll(COLLECTIONS_STORE);
}

export async function addCachedCollection(collection) {
  const db = await dbPromise;
  await db.put(COLLECTIONS_STORE, collection);
}

export async function removeCachedCollection(id) {
  const db = await dbPromise;
  await db.delete(COLLECTIONS_STORE, id);
}

// Files
export async function cacheFilesForCollection(collectionId, files) {
  const db = await dbPromise;
  const tx = db.transaction(FILES_STORE, "readwrite");
  
  // Clear files for this collection
  const allFiles = await tx.store.getAll();
  for (const f of allFiles) {
    if (f.collectionId === collectionId) {
      await tx.store.delete(f._id);
    }
  }
  
  // Add new files
  for (const file of files) {
    await tx.store.put(file);
  }
  await tx.done;
}

export async function getCachedFilesForCollection(collectionId) {
  const db = await dbPromise;
  const allFiles = await db.getAll(FILES_STORE);
  return allFiles.filter((f) => f.collectionId === collectionId);
}

export async function upsertCachedFile(file) {
  const db = await dbPromise;
  await db.put(FILES_STORE, file);
}

export async function removeCachedFile(fileId) {
  const db = await dbPromise;
  await db.delete(FILES_STORE, fileId);
}

// Pending uploads
export async function addPendingUpload(file, collectionId) {
  const db = await dbPromise;
  const entry = {
    id: crypto.randomUUID(),
    collectionId,
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    addedAt: new Date().toISOString(),
    blob: file,
  };
  await db.put(PENDING_STORE, entry);
  return entry;
}

export async function getPendingUploads() {
  const db = await dbPromise;
  return db.getAll(PENDING_STORE);
}

export async function removePendingUpload(id) {
  const db = await dbPromise;
  await db.delete(PENDING_STORE, id);
}