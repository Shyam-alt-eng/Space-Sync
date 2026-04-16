const express = require("express");
const multer = require("multer");
const cors = require("cors");
const mongoose = require("mongoose");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

const PORT = Number(process.env.PORT || 5000);
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/spacesync";
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";
const uploadsDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN },
});

app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

mongoose
  .connect(MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error", err));

const collectionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String, default: "" },
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  }
);

const fileSchema = new mongoose.Schema(
  {
    collectionId: { type: mongoose.Schema.Types.ObjectId, ref: "Collection", required: true },
    originalName: { type: String, required: true },
    storedName: { type: String, required: true },
    displayName: { type: String, default: "" },
    mimeType: { type: String, default: "application/octet-stream" },
    size: { type: Number, default: 0 },
    relativePath: { type: String, required: true },
  },
  {
    timestamps: { createdAt: "uploadedAt", updatedAt: false },
  }
);

const Collection = mongoose.model("Collection", collectionSchema);
const File = mongoose.model("File", fileSchema);

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
});

const toClientCollection = (doc) => ({
  _id: doc._id,
  name: doc.name,
  description: doc.description,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Collections API
app.post("/collections", async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: "Collection name required" });

    const collection = await Collection.create({ name, description: description || "" });
    return res.status(201).json(toClientCollection(collection));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/collections", async (req, res) => {
  try {
    const collections = await Collection.find().sort({ createdAt: -1 });
    return res.json(collections.map(toClientCollection));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.patch("/collections/:id", async (req, res) => {
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

app.delete("/collections/:id", async (req, res) => {
  try {
    const collection = await Collection.findByIdAndDelete(req.params.id);
    if (!collection) return res.status(404).json({ error: "Collection not found" });
    
    // Delete all files in collection
    await File.deleteMany({ collectionId: req.params.id });
    
    io.emit("collection:deleted", { _id: req.params.id });
    return res.json({ message: "Collection deleted" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Files API (collection-scoped)
app.post("/collections/:collectionId/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });
    
    const collectionId = req.params.collectionId;
    const collection = await Collection.findById(collectionId);
    if (!collection) return res.status(404).json({ error: "Collection not found" });

    const fileDoc = await File.create({
      collectionId,
      originalName: req.file.originalname,
      storedName: req.file.filename,
      displayName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      relativePath: path.posix.join("uploads", req.file.filename),
    });

    const payload = toClientFile(fileDoc);
    io.emit("file:created", payload);

    return res.status(201).json(payload);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/collections/:collectionId/files", async (req, res) => {
  try {
    const collection = await Collection.findById(req.params.collectionId);
    if (!collection) return res.status(404).json({ error: "Collection not found" });

    const files = await File.find({ collectionId: req.params.collectionId }).sort({ uploadedAt: -1 }).lean();
    return res.json(files.map(toClientFile));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.patch("/files/:fileId", async (req, res) => {
  try {
    const { displayName } = req.body;
    if (!displayName) return res.status(400).json({ error: "Display name required" });

    const file = await File.findByIdAndUpdate(
      req.params.fileId,
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

app.delete("/files/:fileId", async (req, res) => {
  try {
    const file = await File.findByIdAndDelete(req.params.fileId);
    if (!file) return res.status(404).json({ error: "File not found" });

    // Delete from disk
    const filePath = path.join(uploadsDir, file.storedName);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    io.emit("file:deleted", { _id: req.params.fileId });
    return res.json({ message: "File deleted" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Legacy endpoint for compatibility
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    // Create default collection if needed
    let collection = await Collection.findOne({ name: "Default" });
    if (!collection) {
      collection = await Collection.create({ name: "Default" });
    }

    const fileDoc = await File.create({
      collectionId: collection._id,
      originalName: req.file.originalname,
      storedName: req.file.filename,
      displayName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      relativePath: path.posix.join("uploads", req.file.filename),
    });

    const payload = toClientFile(fileDoc);
    io.emit("file:created", payload);
    io.emit("new_file", payload);

    return res.status(201).json(payload);
  } catch (err) {
    return res.status(500).json({ error: err.message || "Upload failed" });
  }
});

// Legacy endpoint for compatibility
app.get("/files", async (req, res) => {
  try {
    const docs = await File.find().sort({ uploadedAt: -1 }).lean();
    const files = docs.map(toClientFile);
    return res.json(files);
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to fetch files" });
  }
});

app.use("/uploads", express.static(uploadsDir));

const clientDist = path.join(__dirname, "../client/dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));

  app.use((req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

io.on("connection", (socket) => {
  console.log("Socket connected", socket.id);
  socket.on("disconnect", () => {
    console.log("Socket disconnected", socket.id);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});