require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const mongoose = require("mongoose");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

mongoose.set("bufferCommands", false);

const PORT = Number(process.env.PORT || 5000);
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/spacesync";
const normalizeOrigin = (origin) => origin.trim().replace(/\/+$/, "");
const rawClientOrigin = process.env.CLIENT_ORIGIN || "*";
const configuredOrigins = rawClientOrigin === "*"
  ? "*"
  : rawClientOrigin
      .split(",")
      .map((origin) => normalizeOrigin(origin))
      .filter(Boolean);
const devOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];
const CLIENT_ORIGIN = configuredOrigins === "*"
  ? "*"
  : Array.from(new Set([
      ...configuredOrigins,
      ...(process.env.NODE_ENV === "production" ? [] : devOrigins),
    ]));
const ADMIN_SECRET = process.env.ADMIN_SECRET || "admin";
const uploadsDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const app = express();
const server = http.createServer(app);

const defaultUserPermissions = {
  canRead: true,
  canWrite: true,
  canDelete: false,
};

const adminPermissions = {
  canRead: true,
  canWrite: true,
  canDelete: true,
};

const isDevelopment = process.env.NODE_ENV !== "production";

const isDevViteOrigin = (origin) => {
  if (!origin || !isDevelopment) return false;
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname;
    const port = parsed.port;
    const isHttp = parsed.protocol === "http:";
    const isLoopback = host === "localhost" || host === "127.0.0.1";
    const isLanIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    const isVitePort = port === "5173" || port === "4173";
    return isHttp && isVitePort && (isLoopback || isLanIp);
  } catch {
    return false;
  }
};

const isAllowedOrigin = (origin) => {
  if (CLIENT_ORIGIN === "*") return true;
  if (!origin) return true;
  if (isDevViteOrigin(origin)) return true;
  return CLIENT_ORIGIN.includes(normalizeOrigin(origin));
};

const corsOriginOption = CLIENT_ORIGIN === "*"
  ? "*"
  : (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }
      console.warn(`CORS blocked origin: ${origin || "unknown"}`);
      callback(null, false);
    };

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Not allowed by CORS"));
    },
  },
});

app.use(cors({ origin: corsOriginOption }));
app.use(express.json());

mongoose
  .connect(MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error", err));

let gridFsBucket = null;
const getGridFsBucket = () => {
  if (!mongoose.connection?.db) return null;
  if (!gridFsBucket) {
    gridFsBucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
      bucketName: "spacesyncFiles",
    });
  }
  return gridFsBucket;
};

const deviceSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  isAdmin: { type: Boolean, default: false },
  permissions: {
    canRead: { type: Boolean, default: true },
    canWrite: { type: Boolean, default: true },
    canDelete: { type: Boolean, default: true },
  }
}, { timestamps: true });

const collectionSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, default: "" },
}, { timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" } });

const fileSchema = new mongoose.Schema({
  collectionId: { type: mongoose.Schema.Types.ObjectId, ref: "Collection", required: true },
  originalName: { type: String, required: true },
  storedName: { type: String, required: true },
  storageBackend: { type: String, enum: ["disk", "gridfs"], default: "disk" },
  gridFsId: { type: mongoose.Schema.Types.ObjectId },
  displayName: { type: String, default: "" },
  mimeType: { type: String, default: "application/octet-stream" },
  size: { type: Number, default: 0 },
  relativePath: { type: String, required: true },
  uploadedBy: { type: String, required: true },
  isDeleted: { type: Boolean, default: false },
  deletedBy: { type: String }
}, { timestamps: { createdAt: "uploadedAt", updatedAt: false } });

const noteSchema = new mongoose.Schema({
  collectionId: { type: mongoose.Schema.Types.ObjectId, ref: "Collection", required: true },
  text: { type: String, required: true },
  createdBy: { type: String, required: true },
  isDeleted: { type: Boolean, default: false },
  deletedBy: { type: String },
  editedAt: { type: Date }
}, { timestamps: true });

const auditLogSchema = new mongoose.Schema({
  deviceId: { type: String, required: true },
  action: { type: String, required: true },
  resourceType: { type: String, required: true }, 
  resourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
  details: { type: Object },
}, { timestamps: { createdAt: "createdAt", updatedAt: false } });

const Device = mongoose.model("Device", deviceSchema);
const Collection = mongoose.model("Collection", collectionSchema);
const File = mongoose.model("File", fileSchema);
const Note = mongoose.model("Note", noteSchema);
const AuditLog = mongoose.model("AuditLog", auditLogSchema);

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, "-");
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const upload = multer({ storage });

const toClientFile = (doc) => ({
  _id: doc._id,
  collectionId: doc.collectionId,
  originalName: doc.originalName,
  storedName: doc.storedName,
  displayName: doc.displayName || doc.originalName,
  mimeType: doc.mimeType,
  size: doc.size,
  uploadedAt: doc.uploadedAt,
  relativePath: doc.relativePath,
  downloadUrl: `/uploads/${doc.storedName}`,
  uploadedBy: doc.uploadedBy,
  isDeleted: doc.isDeleted
});

const toClientCollection = (doc) => ({
  _id: doc._id,
  name: doc.name,
  description: doc.description,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

const toClientNote = (doc) => ({
  id: doc._id.toString(),
  collectionId: doc.collectionId,
  text: doc.text,
  createdAt: doc.createdAt,
  editedAt: doc.editedAt,
  createdBy: doc.createdBy,
  isDeleted: doc.isDeleted
});

const getDevicePermissions = (device) => {
  if (!device) return { ...defaultUserPermissions };
  if (device.isAdmin) return { ...adminPermissions };
  return {
    canRead: device.permissions?.canRead !== false,
    canWrite: device.permissions?.canWrite !== false,
    canDelete: device.permissions?.canDelete !== false,
  };
};

const isDbReady = () => mongoose.connection.readyState === 1;

const ensureDbReady = (req, res, next) => {
  if (isDbReady()) {
    next();
    return;
  }
  res.status(503).json({ error: "Server is starting. Please retry in a few seconds." });
};

const checkAccess = async (req, res, next) => {
  const deviceId = req.headers['x-device-id'];
  if (!deviceId) return res.status(401).json({ error: "Missing device ID" });
  const device = await Device.findOne({ deviceId });
  if (!device || device.status !== 'approved') return res.status(403).json({ error: "Unauthorized" });
  const permissions = getDevicePermissions(device);
  if (!permissions.canRead) return res.status(403).json({ error: "Read access denied" });
  req.device = device;
  req.permissions = permissions;
  next();
};

const checkWriteAccess = (req, res, next) => {
  if (req.permissions?.canWrite) {
    next();
    return;
  }
  res.status(403).json({ error: "Write access denied" });
};

const checkDeleteAccess = (req, res, next) => {
  if (req.permissions?.canDelete) {
    next();
    return;
  }
  res.status(403).json({ error: "Delete access denied" });
};

const checkAdmin = async (req, res, next) => {
  const deviceId = req.headers['x-device-id'];
  if (!deviceId) return res.status(401).json({ error: "Missing device ID" });
  const device = await Device.findOne({ deviceId });
  if (!device || device.status !== 'approved' || !device.isAdmin) return res.status(403).json({ error: "Unauthorized admin" });
  req.device = device;
  next();
};

app.get("/health", (req, res) => res.json({ status: "ok" }));

// --- Access API ---
app.post("/access/verify", async (req, res) => {
  if (!isDbReady()) {
    return res.status(503).json({ status: 'loading', error: "Database is not ready" });
  }
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ error: "Missing deviceId" });
  const device = await Device.findOne({ deviceId });
  if (!device) return res.json({ status: 'new' });
  return res.json({
    status: device.status,
    isAdmin: device.isAdmin,
    name: device.name,
    permissions: getDevicePermissions(device),
  });
});

app.post("/access/request", async (req, res) => {
  if (!isDbReady()) {
    return res.status(503).json({ error: "Server is starting. Please retry in a few seconds." });
  }
  const { deviceId, name } = req.body;
  if (!deviceId || !name) return res.status(400).json({ error: "Missing fields" });
  let device = await Device.findOne({ deviceId });
  if (!device) {
    device = await Device.create({
      deviceId,
      name,
      status: 'pending',
      permissions: { ...defaultUserPermissions },
    });
  } else {
    device.name = name;
    device.status = 'pending';
    await device.save();
  }
  io.emit("access:requested", { deviceId, name, status: 'pending' });
  return res.json({ status: 'pending' });
});

app.post("/access/admin", async (req, res) => {
  if (!isDbReady()) {
    return res.status(503).json({ error: "Server is starting. Please retry in a few seconds." });
  }
  const { deviceId, name, secret } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: "Invalid secret" });
  let device = await Device.findOne({ deviceId });
  if (!device) {
    device = await Device.create({
      deviceId,
      name: name || "Admin Device",
      status: 'approved',
      isAdmin: true,
      permissions: { ...adminPermissions },
    });
  } else {
    device.status = 'approved';
    device.isAdmin = true;
    device.permissions = { ...adminPermissions };
    await device.save();
  }
  return res.json({ status: 'approved', isAdmin: true, permissions: { ...adminPermissions } });
});

// Admin management endpoints
app.get("/admin/devices", ensureDbReady, checkAdmin, async (req, res) => {
  const devices = await Device.find().sort({ createdAt: -1 });
  res.json(devices);
});

app.post("/admin/devices/:deviceId/approve", ensureDbReady, checkAdmin, async (req, res) => {
  const device = await Device.findOneAndUpdate(
    { deviceId: req.params.deviceId },
    {
      status: 'approved',
      $setOnInsert: { permissions: { ...defaultUserPermissions } },
    },
    { new: true }
  );
  if (!device) return res.status(404).json({ error: "Device not found" });
  if (!device.permissions) {
    device.permissions = { ...defaultUserPermissions };
    await device.save();
  }
  io.emit(`access:approved:${device.deviceId}`);
  res.json(device);
});

app.post("/admin/devices/:deviceId/revoke", ensureDbReady, checkAdmin, async (req, res) => {
  const device = await Device.findOne({ deviceId: req.params.deviceId });
  if (!device) return res.status(404).json({ error: "Device not found" });
  if (device.isAdmin) return res.status(400).json({ error: "Cannot revoke an admin device" });
  device.status = 'rejected';
  await device.save();
  io.emit("access:revoked", { deviceId: device.deviceId });
  res.json(device);
});

app.delete("/admin/devices/:deviceId", ensureDbReady, checkAdmin, async (req, res) => {
  const device = await Device.findOne({ deviceId: req.params.deviceId });
  if (!device) return res.status(404).json({ error: "Device not found" });
  if (device.isAdmin) return res.status(400).json({ error: "Cannot remove an admin device" });

  await Device.deleteOne({ deviceId: req.params.deviceId });
  io.emit("access:revoked", { deviceId: req.params.deviceId });
  res.json({ success: true, deviceId: req.params.deviceId });
});

app.patch("/admin/devices/:deviceId/permissions", ensureDbReady, checkAdmin, async (req, res) => {
  const { canRead, canWrite, canDelete } = req.body;
  const device = await Device.findOne({ deviceId: req.params.deviceId });
  if (!device) return res.status(404).json({ error: "Device not found" });
  if (device.isAdmin) return res.status(400).json({ error: "Admin permissions cannot be changed" });

  const nextPermissions = {
    canRead: canRead !== undefined ? Boolean(canRead) : device.permissions?.canRead !== false,
    canWrite: canWrite !== undefined ? Boolean(canWrite) : device.permissions?.canWrite !== false,
    canDelete: canDelete !== undefined ? Boolean(canDelete) : device.permissions?.canDelete !== false,
  };

  if (nextPermissions.canDelete && !nextPermissions.canWrite) {
    return res.status(400).json({ error: "Delete permission requires write permission" });
  }

  device.permissions = nextPermissions;
  await device.save();
  res.json(device);
});

app.get("/admin/audit", ensureDbReady, checkAdmin, async (req, res) => {
  const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(100).lean();
  
  const deviceIds = [...new Set(logs.map(l => l.deviceId))];
  const devices = await Device.find({ deviceId: { $in: deviceIds } });
  const deviceMap = devices.reduce((acc, d) => ({...acc, [d.deviceId]: d.name}), {});

  const enrichedLogs = logs.map(log => ({
    ...log,
    deviceName: deviceMap[log.deviceId] || "Unknown"
  }));
  res.json(enrichedLogs);
});

app.post("/admin/undo/:logId", ensureDbReady, checkAdmin, async (req, res) => {
  const log = await AuditLog.findById(req.params.logId);
  if (!log) return res.status(404).json({ error: "Log not found" });

  let restoredItem = null;
  if (log.action === 'deleted_file') {
    const file = await File.findByIdAndUpdate(log.resourceId, { isDeleted: false, $unset: { deletedBy: "" } }, { new: true });
    if (file) {
      restoredItem = toClientFile(file);
      io.emit("file:created", restoredItem);
    }
  } else if (log.action === 'deleted_note') {
    const note = await Note.findByIdAndUpdate(log.resourceId, { isDeleted: false, $unset: { deletedBy: "" } }, { new: true });
    if (note) {
      restoredItem = toClientNote(note);
      io.emit("note:created", restoredItem);
    }
  }

  await AuditLog.findByIdAndDelete(req.params.logId);
  res.json({ success: true });
});

app.delete("/admin/permanent/:logId", ensureDbReady, checkAdmin, async (req, res) => {
  const log = await AuditLog.findById(req.params.logId);
  if (!log) return res.status(404).json({ error: "Log not found" });

  if (log.action === 'deleted_file') {
    const file = await File.findById(log.resourceId);
    if (file) {
      if (file.storageBackend === "gridfs" && file.gridFsId) {
        const bucket = getGridFsBucket();
        if (bucket) {
          try {
            await bucket.delete(file.gridFsId);
          } catch {
            // Ignore cleanup errors for already-missing GridFS files
          }
        }
      }

      const filePath = path.join(uploadsDir, file.storedName);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      await File.findByIdAndDelete(log.resourceId);
    }
  } else if (log.action === 'deleted_note') {
    await Note.findByIdAndDelete(log.resourceId);
  }

  await AuditLog.findByIdAndDelete(req.params.logId);
  res.json({ success: true });
});

// --- Collections API ---
app.post("/collections", ensureDbReady, checkAccess, checkWriteAccess, async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: "Collection name required" });
    const collection = await Collection.create({ name, description: description || "" });
    return res.status(201).json(toClientCollection(collection));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/collections", ensureDbReady, checkAccess, async (req, res) => {
  try {
    const collections = await Collection.find().sort({ createdAt: -1 });
    return res.json(collections.map(toClientCollection));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.patch("/collections/:id", ensureDbReady, checkAccess, checkWriteAccess, async (req, res) => {
  try {
    const { name, description } = req.body;
    const collection = await Collection.findByIdAndUpdate(
      req.params.id,
      { ...(name && { name }), ...(description !== undefined && { description }) },
      { new: true }
    );
    if (!collection) return res.status(404).json({ error: "Collection not found" });
    return res.json(toClientCollection(collection));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete("/collections/:id", ensureDbReady, checkAccess, checkDeleteAccess, async (req, res) => {
  try {
    const collection = await Collection.findByIdAndDelete(req.params.id);
    if (!collection) return res.status(404).json({ error: "Collection not found" });
    await File.updateMany({ collectionId: req.params.id }, { isDeleted: true, deletedBy: req.device.deviceId });
    await Note.updateMany({ collectionId: req.params.id }, { isDeleted: true, deletedBy: req.device.deviceId });
    io.emit("collection:deleted", { _id: req.params.id });
    return res.json({ message: "Collection deleted" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// --- Files API ---
app.post("/collections/:collectionId/upload", ensureDbReady, checkAccess, checkWriteAccess, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });
    const collectionId = req.params.collectionId;
    const collection = await Collection.findById(collectionId);
    if (!collection) return res.status(404).json({ error: "Collection not found" });

    let storageBackend = "disk";
    let gridFsId;
    const localFilePath = path.join(uploadsDir, req.file.filename);
    const bucket = getGridFsBucket();

    if (bucket) {
      const uploadStream = bucket.openUploadStream(req.file.filename, {
        contentType: req.file.mimetype,
        metadata: {
          originalName: req.file.originalname,
          uploadedBy: req.device.deviceId,
        },
      });

      await new Promise((resolve, reject) => {
        fs.createReadStream(localFilePath)
          .pipe(uploadStream)
          .on("error", reject)
          .on("finish", resolve);
      });

      storageBackend = "gridfs";
      gridFsId = uploadStream.id;
      fs.unlink(localFilePath, () => {});
    }

    const fileDoc = await File.create({
      collectionId,
      originalName: req.file.originalname,
      storedName: req.file.filename,
      storageBackend,
      gridFsId,
      displayName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      relativePath: path.posix.join("uploads", req.file.filename),
      uploadedBy: req.device.deviceId
    });

    await AuditLog.create({
      deviceId: req.device.deviceId,
      action: 'uploaded_file',
      resourceType: 'file',
      resourceId: fileDoc._id,
      details: { fileName: fileDoc.originalName }
    });

    const payload = toClientFile(fileDoc);
    io.emit("file:created", payload);
    return res.status(201).json(payload);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/collections/:collectionId/files", ensureDbReady, checkAccess, async (req, res) => {
  try {
    const files = await File.find({ collectionId: req.params.collectionId, isDeleted: false }).sort({ uploadedAt: -1 }).lean();
    return res.json(files.map(toClientFile));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.patch("/files/:fileId", ensureDbReady, checkAccess, checkWriteAccess, async (req, res) => {
  try {
    const { displayName } = req.body;
    if (!displayName) return res.status(400).json({ error: "Display name required" });
    const file = await File.findOneAndUpdate(
      { _id: req.params.fileId, isDeleted: false },
      { displayName },
      { new: true }
    );
    if (!file) return res.status(404).json({ error: "File not found" });
    const payload = toClientFile(file);
    io.emit("file:renamed", payload);
    return res.json(payload);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/files/:fileId/download", ensureDbReady, checkAccess, async (req, res) => {
  try {
    const file = await File.findOne({ _id: req.params.fileId, isDeleted: false }).lean();
    if (!file) return res.status(404).json({ error: "File not found" });

    const requestedName = (file.displayName || file.originalName || "download").trim();
    const safeDownloadName = path.basename(requestedName);

    if (file.storageBackend === "gridfs" && file.gridFsId) {
      const bucket = getGridFsBucket();
      if (!bucket) return res.status(503).json({ error: "File storage is not ready" });

      res.attachment(safeDownloadName);
      res.setHeader("Content-Type", file.mimeType || "application/octet-stream");

      const downloadStream = bucket.openDownloadStream(file.gridFsId);
      downloadStream.on("error", () => {
        if (!res.headersSent) {
          res.status(404).json({ error: "Stored file missing" });
        } else {
          res.end();
        }
      });
      downloadStream.pipe(res);
      return;
    }

    const filePath = path.join(uploadsDir, file.storedName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Stored file missing" });
    return res.download(filePath, safeDownloadName);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete("/files/:fileId", ensureDbReady, checkAccess, checkDeleteAccess, async (req, res) => {
  try {
    const file = await File.findOneAndUpdate(
      { _id: req.params.fileId, isDeleted: false },
      { isDeleted: true, deletedBy: req.device.deviceId },
      { new: true }
    );
    if (!file) return res.status(404).json({ error: "File not found" });

    await AuditLog.create({
      deviceId: req.device.deviceId,
      action: 'deleted_file',
      resourceType: 'file',
      resourceId: file._id,
      details: { fileName: file.displayName || file.originalName }
    });

    io.emit("file:deleted", { _id: req.params.fileId });
    return res.json({ message: "File soft deleted" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// --- Notes API ---
app.post("/collections/:collectionId/notes", ensureDbReady, checkAccess, checkWriteAccess, async (req, res) => {
  try {
    const { text, id: localId } = req.body;
    if (!text) return res.status(400).json({ error: "Text required" });
    
    const note = await Note.create({
      collectionId: req.params.collectionId,
      text,
      createdBy: req.device.deviceId
    });

    await AuditLog.create({
      deviceId: req.device.deviceId,
      action: 'created_note',
      resourceType: 'note',
      resourceId: note._id,
      details: { snippet: text.substring(0, 30) }
    });

    const payload = toClientNote(note);
    if (localId) payload.localId = localId; 
    io.emit("note:created", payload);
    return res.status(201).json(payload);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/collections/:collectionId/notes", ensureDbReady, checkAccess, async (req, res) => {
  try {
    const notes = await Note.find({ collectionId: req.params.collectionId, isDeleted: false }).sort({ createdAt: 1 }).lean();
    return res.json(notes.map(toClientNote));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.patch("/notes/:noteId", ensureDbReady, checkAccess, checkWriteAccess, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "Text required" });
    const previous = await Note.findOne({ _id: req.params.noteId, isDeleted: false }).lean();
    if (!previous) return res.status(404).json({ error: "Note not found" });

    const note = await Note.findOneAndUpdate(
      { _id: req.params.noteId, isDeleted: false },
      { text, editedAt: new Date() },
      { new: true }
    );
    if (!note) return res.status(404).json({ error: "Note not found" });

    await AuditLog.create({
      deviceId: req.device.deviceId,
      action: 'edited_note',
      resourceType: 'note',
      resourceId: note._id,
      details: {
        before: (previous.text || "").substring(0, 30),
        after: (text || "").substring(0, 30)
      }
    });
    
    const payload = toClientNote(note);
    io.emit("note:updated", payload);
    return res.json(payload);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete("/notes/:noteId", ensureDbReady, checkAccess, checkWriteAccess, async (req, res) => {
  try {
    const note = await Note.findOneAndUpdate(
      { _id: req.params.noteId, isDeleted: false },
      { isDeleted: true, deletedBy: req.device.deviceId },
      { new: true }
    );
    if (!note) return res.status(404).json({ error: "Note not found" });

    await AuditLog.create({
      deviceId: req.device.deviceId,
      action: 'deleted_note',
      resourceType: 'note',
      resourceId: note._id,
      details: { snippet: note.text.substring(0, 30) }
    });

    io.emit("note:deleted", { id: note._id.toString() });
    return res.json({ message: "Note soft deleted" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.use("/uploads", express.static(uploadsDir));

const clientDist = path.join(__dirname, "../client/dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.use((req, res) => res.sendFile(path.join(clientDist, "index.html")));
}

io.on("connection", (socket) => {
  console.log("Socket connected", socket.id);
  socket.on("disconnect", () => console.log("Socket disconnected", socket.id));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});