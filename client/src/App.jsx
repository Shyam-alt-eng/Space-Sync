import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { io } from "socket.io-client";
import {
  addPendingUpload,
  cacheCollections,
  getCachedCollections,
  addCachedCollection,
  cacheFilesForCollection,
  getCachedFilesForCollection,
  upsertCachedFile,
  removeCachedFile,
  getPendingUploads,
  removePendingUpload,
} from "./db";
import "./App.css";
const DEFAULT_API_URL = import.meta.env.DEV
  ? `${window.location.protocol}//${window.location.hostname}:5000`
  : "";
const BASE_URL = import.meta.env.VITE_API_URL || DEFAULT_API_URL;

// Device ID Logic
const getDeviceId = () => {
  let id = localStorage.getItem("spacesync-device-id");
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
    localStorage.setItem("spacesync-device-id", id);
  }
  return id;
};
const deviceId = getDeviceId();

const api = axios.create({ baseURL: BASE_URL });
api.interceptors.request.use((config) => {
  config.headers["x-device-id"] = getDeviceId();
  return config;
});

const socket = io(BASE_URL || undefined, {
  transports: ["websocket", "polling"],
});

const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

const readableBytes = (bytes) => {
  if (!bytes && bytes !== 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const getApiError = (err, fallback) => err?.response?.data?.error || fallback;

function App() {
  // Application State
  const [collections, setCollections] = useState([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState(null);
  const [files, setFiles] = useState([]);
  const [notes, setNotes] = useState([]);
  const [pendingUploads, setPendingUploads] = useState([]);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isUploading, setIsUploading] = useState(false);
  const [isSyncingPending, setIsSyncingPending] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [syncMessage, setSyncMessage] = useState("Ready");
  
  // UI State
  const [selectedFile, setSelectedFile] = useState(null);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [isCollectionMenuOpen, setIsCollectionMenuOpen] = useState(false);
  const [isCreateCollectionOpen, setIsCreateCollectionOpen] = useState(false);
  const [isAttachmentOpen, setIsAttachmentOpen] = useState(false);
  const [isSidebarNavMode, setIsSidebarNavMode] = useState(window.innerWidth <= 1024);
  const [composerText, setComposerText] = useState("");
  const [renamingFileId, setRenamingFileId] = useState(null);
  const [renamingFileName, setRenamingFileName] = useState("");
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editingMessageText, setEditingMessageText] = useState("");
  const [renamingCollectionId, setRenamingCollectionId] = useState(null);
  const [renamingCollectionName, setRenamingCollectionName] = useState("");
  
  // Access Control State
  const [accessStatus, setAccessStatus] = useState('loading'); // 'loading' | 'new' | 'pending' | 'approved' | 'rejected'
  const [isAdmin, setIsAdmin] = useState(false);
  const [permissions, setPermissions] = useState({ canRead: true, canWrite: true, canDelete: true });
  const [lockName, setLockName] = useState("");
  const [lockSecret, setLockSecret] = useState("");
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  const [accessMessage, setAccessMessage] = useState("");
  const [isSubmittingAccess, setIsSubmittingAccess] = useState(false);

  // Admin Panel State
  const [isAdminModalOpen, setIsAdminModalOpen] = useState(false);
  const [adminTab, setAdminTab] = useState('requests');
  const [adminDevices, setAdminDevices] = useState([]);
  const [adminAudits, setAdminAudits] = useState([]);
  const [updatingPermissionFor, setUpdatingPermissionFor] = useState("");
  const [removingDeviceId, setRemovingDeviceId] = useState("");

  const collectionInputRef = useRef(null);
  const imagesInputRef = useRef(null);
  const docsInputRef = useRef(null);
  const videosInputRef = useRef(null);
  
  const selectedCollection = collections.find((c) => c._id === selectedCollectionId);
  const shouldShowCollectionMenu = isSidebarNavMode || isCollectionMenuOpen;
  const currentPending = pendingUploads.filter((p) => p.collectionId === selectedCollectionId);
  const canWrite = isAdmin || permissions.canWrite;
  const canDelete = isAdmin || permissions.canDelete;

  const adminUserTracking = useMemo(() => {
    const byDevice = new Map();

    for (const device of adminDevices) {
      byDevice.set(device.deviceId, {
        deviceId: device.deviceId,
        name: device.name,
        status: device.status,
        totalEvents: 0,
        uploads: 0,
        createdNotes: 0,
        editedNotes: 0,
        deletedItems: 0,
        lastActivityAt: null,
      });
    }

    for (const audit of adminAudits) {
      const existing = byDevice.get(audit.deviceId) || {
        deviceId: audit.deviceId,
        name: audit.deviceName || "Unknown",
        status: "unknown",
        totalEvents: 0,
        uploads: 0,
        createdNotes: 0,
        editedNotes: 0,
        deletedItems: 0,
        lastActivityAt: null,
      };

      existing.totalEvents += 1;
      if (audit.action === "uploaded_file") existing.uploads += 1;
      if (audit.action === "created_note") existing.createdNotes += 1;
      if (audit.action === "edited_note") existing.editedNotes += 1;
      if (audit.action?.startsWith("deleted_")) existing.deletedItems += 1;

      if (!existing.lastActivityAt || new Date(audit.createdAt).getTime() > new Date(existing.lastActivityAt).getTime()) {
        existing.lastActivityAt = audit.createdAt;
      }

      byDevice.set(audit.deviceId, existing);
    }

    return Array.from(byDevice.values()).sort((a, b) => {
      const aTs = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
      const bTs = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
      return bTs - aTs;
    });
  }, [adminDevices, adminAudits]);

  const timelineItems = useMemo(() => {
    const noteItems = notes.map((note) => ({
      kind: "note",
      id: note.id,
      ts: new Date(note.createdAt).getTime(),
      payload: note,
    }));

    const pendingItems = currentPending.map((pending) => ({
      kind: "pending",
      id: pending.id,
      ts: new Date(pending.addedAt || Date.now()).getTime(),
      payload: pending,
    }));

    const fileItems = files.map((file) => ({
      kind: "file",
      id: file._id,
      ts: new Date(file.uploadedAt).getTime(),
      payload: file,
    }));

    return [...noteItems, ...pendingItems, ...fileItems].sort((a, b) => a.ts - b.ts);
  }, [notes, currentPending, files]);

  // Auth Checks
  const refreshAccessState = async (attempt = 0) => {
    try {
      const res = await api.post("/access/verify", { deviceId });
      setAccessStatus(res.data.status);
      setIsAdmin(res.data.isAdmin || false);
      setPermissions(res.data.permissions || { canRead: true, canWrite: true, canDelete: true });
      setAccessMessage("");
    } catch (err) {
      const statusCode = err?.response?.status;
      if (statusCode === 503 && attempt < 3) {
        setAccessMessage("Server is warming up. Retrying...");
        setTimeout(() => refreshAccessState(attempt + 1), 1500);
        return;
      }
      setAccessStatus('new');
      setIsAdmin(false);
      setPermissions({ canRead: true, canWrite: true, canDelete: true });
      setAccessMessage(getApiError(err, "Unable to verify access right now. You can still submit a request."));
    }
  };

  useEffect(() => {
    refreshAccessState();
  }, []);

  useEffect(() => {
    const handleResize = () => {
      const isCompact = window.innerWidth <= 1024;
      setIsSidebarNavMode(isCompact);
      if (isCompact) {
        setIsCollectionMenuOpen(true);
      }
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    if (isSidebarNavMode) {
      setIsCollectionMenuOpen(true);
    }
  }, [isSidebarNavMode]);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      setSyncMessage("Back online. Syncing latest updates...");
    };
    const handleOffline = () => {
      setIsOnline(false);
      setSyncMessage("You are offline. Work is cached locally.");
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    const onConnect = () => {
      setSyncMessage("Realtime connected");
    };
    const onDisconnect = () => {
      setSyncMessage("Realtime disconnected. Retrying...");
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, []);

  useEffect(() => {
    socket.on("access:requested", (data) => {
      if (isAdmin) setSyncMessage(`Access requested by ${data.name}`);
    });
    socket.on(`access:approved:${deviceId}`, () => {
      setSyncMessage("Access Approved!");
      refreshAccessState();
    });
    socket.on("access:revoked", (data) => {
      if (data.deviceId === deviceId) {
        setAccessStatus('rejected');
        setAccessMessage("Your access was revoked by admin.");
      }
    });

    return () => {
      socket.off("access:requested");
      socket.off(`access:approved:${deviceId}`);
      socket.off("access:revoked");
    };
  }, [isAdmin]);

  const requestAccess = async () => {
    if (!lockName.trim()) return;
    try {
      setIsSubmittingAccess(true);
      const res = await api.post("/access/request", { deviceId, name: lockName });
      setAccessStatus(res.data.status);
      setAccessMessage("Request submitted. Waiting for admin approval.");
    } catch (err) {
      setAccessMessage(getApiError(err, "Failed to request access"));
    } finally {
      setIsSubmittingAccess(false);
    }
  };

  const loginAdmin = async () => {
    try {
      setIsSubmittingAccess(true);
      const res = await api.post("/access/admin", { deviceId, secret: lockSecret });
      setAccessStatus(res.data.status);
      setIsAdmin(res.data.isAdmin);
      setPermissions(res.data.permissions || { canRead: true, canWrite: true, canDelete: true });
      setShowAdminLogin(false);
      setAccessMessage("");
    } catch (err) {
      setAccessMessage(getApiError(err, "Invalid secret"));
    } finally {
      setIsSubmittingAccess(false);
    }
  };

  // --- Core Application Logic ---
  const hydrateFromCache = async () => {
    const [cachedCollections, cachedPending] = await Promise.all([
      getCachedCollections(),
      getPendingUploads(),
    ]);
    setCollections(cachedCollections);
    setPendingUploads(cachedPending);

    if (cachedCollections.length > 0 && !selectedCollectionId) {
      setSelectedCollectionId(cachedCollections[0]._id);
      const cachedFiles = await getCachedFilesForCollection(cachedCollections[0]._id);
      setFiles(cachedFiles);
    }
  };

  const fetchCollections = async () => {
    try {
      const res = await api.get("/collections");
      setCollections(res.data);
      await cacheCollections(res.data);
      if (res.data.length > 0 && !selectedCollectionId) {
        setSelectedCollectionId(res.data[0]._id);
      } else if (selectedCollectionId && !res.data.some((c) => c._id === selectedCollectionId)) {
        setSelectedCollectionId(res.data[0]?._id || null);
      }
    } catch {
      await hydrateFromCache();
    }
  };

  const fetchCollectionData = async (collectionId, options = {}) => {
    const { silent = false } = options;
    if (!collectionId) return;
    try {
      const [filesRes, notesRes] = await Promise.all([
        api.get(`/collections/${collectionId}/files`),
        api.get(`/collections/${collectionId}/notes`)
      ]);
      setFiles(filesRes.data);
      setNotes(notesRes.data);
      await cacheFilesForCollection(collectionId, filesRes.data);
      if (!silent) {
        setSyncMessage(`Synced ${filesRes.data.length} files, ${notesRes.data.length} notes`);
      }
    } catch {
      const cachedFiles = await getCachedFilesForCollection(collectionId);
      setFiles(cachedFiles);
      setNotes([]);
      if (!silent) {
        setSyncMessage("Showing cached files");
      }
    }
  };

  const refreshWorkspaceData = async () => {
    if (accessStatus !== "approved") return;
    await fetchCollections();
    if (selectedCollectionId) {
      await fetchCollectionData(selectedCollectionId, { silent: true });
    }
    if (isAdmin && isAdminModalOpen) {
      await fetchAdminData();
    }
  };

  useEffect(() => {
    if (accessStatus === 'approved') {
      fetchCollections();
    }
  }, [accessStatus]);

  useEffect(() => {
    if (accessStatus === 'approved' && selectedCollectionId) {
      fetchCollectionData(selectedCollectionId);
    }
  }, [selectedCollectionId, accessStatus]);

  useEffect(() => {
    if (accessStatus !== "approved") return;
    const interval = setInterval(() => {
      refreshWorkspaceData();
    }, 5000);

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        refreshWorkspaceData();
      }
    };

    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [accessStatus, selectedCollectionId, isAdminModalOpen, isAdmin]);

  useEffect(() => {
    if (accessStatus !== 'approved') return;

    const onFileUpsert = async (newFile) => {
      if (newFile.collectionId === selectedCollectionId) {
        setFiles(prev => [newFile, ...prev.filter(f => f._id !== newFile._id)]);
        await upsertCachedFile(newFile);
      }
    };
    const onFileDelete = ({ _id }) => {
      setFiles(prev => prev.filter(f => f._id !== _id));
      removeCachedFile(_id);
    };

    const onNoteUpsert = (newNote) => {
      if (newNote.collectionId === selectedCollectionId) {
        setNotes(prev => [...prev.filter(n => n.id !== newNote.id && n.id !== newNote.localId), newNote]);
      }
    };
    const onNoteDelete = ({ id }) => {
      setNotes(prev => prev.filter(n => n.id !== id));
    };

    socket.on("file:created", onFileUpsert);
    socket.on("file:renamed", onFileUpsert);
    socket.on("file:deleted", onFileDelete);
    
    socket.on("note:created", onNoteUpsert);
    socket.on("note:updated", onNoteUpsert);
    socket.on("note:deleted", onNoteDelete);

    socket.on("collection:deleted", ({ _id }) => {
      fetchCollections();
    });

    return () => {
      socket.off("file:created"); socket.off("file:renamed"); socket.off("file:deleted");
      socket.off("note:created"); socket.off("note:updated"); socket.off("note:deleted");
      socket.off("collection:deleted");
    };
  }, [selectedCollectionId, accessStatus]);

  // Actions
  const createCollection = async () => {
    if (!newCollectionName.trim()) return;
    if (!canWrite) {
      setSyncMessage("Write permission required");
      return;
    }
    try {
      const res = await api.post("/collections", { name: newCollectionName });
      setCollections((prev) => [res.data, ...prev]);
      await addCachedCollection(res.data);
      setNewCollectionName("");
      setSelectedCollectionId(res.data._id);
      setIsCreateCollectionOpen(false);
      setIsCollectionMenuOpen(false);
    } catch { setSyncMessage("Failed to create collection"); }
  };

  const deleteCollection = async (collectionId) => {
    if (!canDelete) {
      setSyncMessage("Delete permission required");
      return;
    }
    try {
      await api.delete(`/collections/${collectionId}`);
    } catch { setSyncMessage("Failed to delete collection"); }
  };

  const renameCollection = async (collectionId) => {
    if (!renamingCollectionName.trim() || renamingCollectionId !== collectionId) return;
    if (!canWrite) {
      setSyncMessage("Write permission required");
      return;
    }
    try {
      const res = await api.patch(`/collections/${collectionId}`, { name: renamingCollectionName });
      setCollections((prev) => prev.map((c) => (c._id === collectionId ? res.data : c)));
      setRenamingCollectionId(null);
    } catch { setSyncMessage("Failed to rename collection"); }
  };

  const uploadFile = async (fileToUpload) => {
    if (!fileToUpload || !selectedCollectionId) return;
    if (!canWrite) {
      setSyncMessage("Write permission required");
      return;
    }
    if (!isOnline) {
      const queued = await addPendingUpload(fileToUpload, selectedCollectionId);
      setPendingUploads((prev) => [queued, ...prev]);
      setSelectedFile(null);
      setSyncMessage("No internet. File queued and will auto-upload on reconnect.");
      return;
    }
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", fileToUpload);
      await api.post(`/collections/${selectedCollectionId}/upload`, formData, {
        onUploadProgress: (event) => {
          const total = event.total || fileToUpload.size || 0;
          const loaded = event.loaded || 0;
          const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
          setUploadProgress({
            kind: "direct",
            name: fileToUpload.name,
            loaded,
            total,
            percent,
          });
        },
      });
      setSelectedFile(null);
      setSyncMessage("Upload completed");
    } catch (e) {
      console.log(e);
      setSyncMessage("Upload failed");
    } finally {
      setIsUploading(false);
      setUploadProgress(null);
    }
  };

  const syncPendingUploads = async () => {
    if (!isOnline || accessStatus !== "approved" || !canWrite || pendingUploads.length === 0 || isSyncingPending) {
      return;
    }

    setIsSyncingPending(true);
    let uploadedCount = 0;

    const sortedPending = [...pendingUploads].sort((a, b) => {
      return new Date(a.addedAt || 0).getTime() - new Date(b.addedAt || 0).getTime();
    });

    for (const entry of sortedPending) {
      try {
        const formData = new FormData();
        formData.append("file", entry.blob, entry.name);
        await api.post(`/collections/${entry.collectionId}/upload`, formData, {
          onUploadProgress: (event) => {
            const total = event.total || entry.size || 0;
            const loaded = event.loaded || 0;
            const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
            setUploadProgress({
              kind: "pending",
              id: entry.id,
              name: entry.name,
              loaded,
              total,
              percent,
            });
          },
        });

        await removePendingUpload(entry.id);
        setPendingUploads((prev) => prev.filter((p) => p.id !== entry.id));
        uploadedCount += 1;
      } catch {
        setSyncMessage("Some queued uploads are still pending. Will retry automatically.");
        break;
      }
    }

    if (uploadedCount > 0) {
      setSyncMessage(`Synced ${uploadedCount} queued upload${uploadedCount > 1 ? "s" : ""}`);
    }
    setUploadProgress(null);
    setIsSyncingPending(false);
  };

  useEffect(() => {
    syncPendingUploads();
  }, [isOnline, pendingUploads.length, accessStatus, canWrite]);

  const deleteFile = async (fileId) => {
    if (!canDelete) {
      setSyncMessage("Delete permission required");
      return;
    }
    try { await api.delete(`/files/${fileId}`); } catch { setSyncMessage("Failed to delete file"); }
  };

  const renameFile = async (fileId) => {
    if (!renamingFileName.trim() || renamingFileId !== fileId) return;
    if (!canWrite) {
      setSyncMessage("Write permission required");
      return;
    }
    try {
      await api.patch(`/files/${fileId}`, { displayName: renamingFileName.trim() });
      setRenamingFileId(null);
    } catch { setSyncMessage("Failed to rename file"); }
  };

  const sendMessage = async () => {
    if (!selectedCollectionId) return;
    if (!canWrite) {
      setSyncMessage("Write permission required");
      return;
    }
    const trimmed = composerText.trim();
    if (trimmed) {
      try {
        const localId = `local-${Date.now()}`;
        setNotes(prev => [...prev, { id: localId, text: trimmed, createdAt: new Date().toISOString(), createdBy: deviceId }]);
        setComposerText("");
        await api.post(`/collections/${selectedCollectionId}/notes`, { text: trimmed, id: localId });
      } catch {
        setSyncMessage("Failed to send message");
      }
    }
    if (selectedFile) {
      await uploadFile(selectedFile);
    }
    setIsAttachmentOpen(false);
  };

  const saveEditedMessage = async (messageId) => {
    if (!canWrite) {
      setSyncMessage("Write permission required");
      return;
    }
    const trimmed = editingMessageText.trim();
    if (!trimmed) {
      try { await api.delete(`/notes/${messageId}`); } catch {}
      cancelEditingMessage();
      return;
    }
    try {
      await api.patch(`/notes/${messageId}`, { text: trimmed });
      cancelEditingMessage();
    } catch { setSyncMessage("Failed to update note"); }
  };

  const deleteMessage = async (messageId) => {
    if (!canWrite) {
      setSyncMessage("Write permission required");
      return;
    }
    try { await api.delete(`/notes/${messageId}`); } catch { setSyncMessage("Failed to delete note"); }
  };

  const startEditingMessage = (note) => { setEditingMessageId(note.id); setEditingMessageText(note.text); };
  const cancelEditingMessage = () => { setEditingMessageId(null); setEditingMessageText(""); };

  const copyText = (text) => {
    navigator.clipboard.writeText(text);
    setSyncMessage("Copied to clipboard!");
  };

  const logoutDevice = () => {
    const shouldLogout = window.confirm("Log out from this device? You can request access again anytime.");
    if (!shouldLogout) return;
    localStorage.removeItem("spacesync-device-id");
    socket.disconnect();
    window.location.reload();
  };

  // Admin Actions
  const fetchAdminData = async () => {
    if (!isAdmin) return;
    try {
      const [devRes, auditRes] = await Promise.all([
        api.get('/admin/devices'),
        api.get('/admin/audit')
      ]);
      setAdminDevices(devRes.data);
      setAdminAudits(auditRes.data);
    } catch { setSyncMessage("Failed to fetch admin data"); }
  };

  useEffect(() => {
    if (isAdminModalOpen) fetchAdminData();
  }, [isAdminModalOpen, adminTab]);

  useEffect(() => {
    if (!isAdmin && isAdminModalOpen) {
      setIsAdminModalOpen(false);
    }
  }, [isAdmin, isAdminModalOpen]);

  const approveDevice = async (id) => {
    await api.post(`/admin/devices/${id}/approve`);
    fetchAdminData();
  };
  const revokeDevice = async (id) => {
    await api.post(`/admin/devices/${id}/revoke`);
    fetchAdminData();
  };
  const removeDevice = async (id) => {
    try {
      setRemovingDeviceId(id);
      await api.delete(`/admin/devices/${id}`);
      await fetchAdminData();
    } catch (err) {
      setSyncMessage(getApiError(err, "Failed to remove user"));
    } finally {
      setRemovingDeviceId("");
    }
  };
  const undoLog = async (id) => {
    await api.post(`/admin/undo/${id}`);
    fetchAdminData();
  };
  const permanentDeleteLog = async (id) => {
    await api.delete(`/admin/permanent/${id}`);
    fetchAdminData();
  };

  const updateDevicePermission = async (device, key, value) => {
    const current = {
      canRead: device.permissions?.canRead !== false,
      canWrite: device.permissions?.canWrite !== false,
      canDelete: device.permissions?.canDelete !== false,
    };
    const next = { ...current, [key]: value };
    if (key === "canWrite" && !value) next.canDelete = false;
    if (key === "canDelete" && value) next.canWrite = true;

    try {
      setUpdatingPermissionFor(device.deviceId);
      await api.patch(`/admin/devices/${device.deviceId}/permissions`, next);
      await fetchAdminData();
    } catch (err) {
      setSyncMessage(getApiError(err, "Failed to update permissions"));
    } finally {
      setUpdatingPermissionFor("");
    }
  };

  // Render logic
  if (accessStatus === 'loading') {
    return (
      <div className="lock-screen-wrapper">
        <div className="lock-card">
          <h2>Starting SpaceSync</h2>
          <p>Please wait while we verify access...</p>
        </div>
      </div>
    );
  }

  if (accessStatus !== 'approved') {
    return (
      <div className="lock-screen-wrapper">
        <div className="lock-card">
          <h2>SpaceSync Locked</h2>
          {showAdminLogin ? (
            <>
              <p>Enter Admin Secret</p>
              <input value={lockSecret} onChange={e=>setLockSecret(e.target.value)} type="password" placeholder="Admin Secret" className="lock-input" />
              <button onClick={loginAdmin} className="lock-btn" disabled={isSubmittingAccess || !lockSecret.trim()}>{isSubmittingAccess ? "Checking..." : "Unlock"}</button>
              <button onClick={()=>setShowAdminLogin(false)} className="lock-alt">Back to Request</button>
            </>
          ) : accessStatus === 'rejected' ? (
            <>
              <p>Your access is currently blocked. You can submit a new request for review.</p>
              <input value={lockName} onChange={e=>setLockName(e.target.value)} placeholder="e.g. John's iPad" className="lock-input" />
              <button onClick={requestAccess} className="lock-btn" disabled={isSubmittingAccess || !lockName.trim()}>{isSubmittingAccess ? "Submitting..." : "Request Access Again"}</button>
              <button onClick={()=>setShowAdminLogin(true)} className="lock-alt" style={{marginTop: "1rem"}}>I am the Admin</button>
            </>
          ) : accessStatus === 'pending' ? (
            <>
              <p>Your request is pending admin approval.</p>
              <button onClick={() => refreshAccessState()} className="lock-alt">Refresh status</button>
            </>
          ) : (
            <>
              <p>Enter a device name to request access.</p>
              <input value={lockName} onChange={e=>setLockName(e.target.value)} placeholder="e.g. John's iPad" className="lock-input" />
              <button onClick={requestAccess} className="lock-btn" disabled={isSubmittingAccess || !lockName.trim()}>{isSubmittingAccess ? "Submitting..." : "Request Access"}</button>
              <button onClick={()=>setShowAdminLogin(true)} className="lock-alt">I am the Admin</button>
            </>
          )}
          {accessMessage && <p className="lock-feedback">{accessMessage}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className={`app-shell ${isSidebarNavMode ? "sidebar-nav-mode" : ""}`}>
      <header className="top-bar">
        <div className={`collection-dropdown ${shouldShowCollectionMenu ? "open" : ""} ${isSidebarNavMode ? "sidebar-open" : ""}`}>
          <button className="dropdown-trigger" onClick={() => { if (!isSidebarNavMode) setIsCollectionMenuOpen(p => !p); }}>
            <span>{selectedCollection?.name || "My Collection"}</span>
            <span className="caret">▾</span>
          </button>
          {shouldShowCollectionMenu && (
            <div className="dropdown-menu">
              <div className="menu-list">
                {collections.map((col) => (
                  <div key={col._id} className={`menu-item ${selectedCollectionId === col._id ? "active" : ""}`} onClick={() => { setSelectedCollectionId(col._id); if (!isSidebarNavMode) setIsCollectionMenuOpen(false); }}>
                    {renamingCollectionId === col._id ? (
                      <input autoFocus value={renamingCollectionName} onChange={(e) => setRenamingCollectionName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") renameCollection(col._id); if (e.key === "Escape") setRenamingCollectionId(null); }} onClick={(e) => e.stopPropagation()} />
                    ) : (
                      <span onDoubleClick={(e) => { e.stopPropagation(); setRenamingCollectionId(col._id); setRenamingCollectionName(col.name); }}>{col.name}</span>
                    )}
                      {canDelete && <button className="menu-delete" onClick={(e) => { e.stopPropagation(); deleteCollection(col._id); }} title="Delete">✕</button>}
                  </div>
                ))}
              </div>
              {canWrite && isCreateCollectionOpen ? (
                <div className="create-collection-inline">
                  <input ref={collectionInputRef} type="text" placeholder="Name" value={newCollectionName} onChange={(e) => setNewCollectionName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") createCollection(); if (e.key === "Escape") { setIsCreateCollectionOpen(false); setNewCollectionName(""); } }} />
                  <button onClick={createCollection} disabled={!newCollectionName.trim()}>Create</button>
                </div>
              ) : canWrite ? (
                <button className="menu-create" onClick={() => setIsCreateCollectionOpen(true)}>+ Create New</button>
              ) : null}
            </div>
          )}
        </div>

        <div className="top-status">
          {isAdmin && <button className="admin-btn" onClick={() => setIsAdminModalOpen(true)}>Manage Access</button>}
          <button className="admin-btn" onClick={logoutDevice}>Logout</button>
          <span className={`status-dot ${isOnline ? "online" : "offline"}`} />
          <span>{isOnline ? "Online" : "Offline"}</span>
        </div>
      </header>

      <main className="chat-stage">
        {selectedCollectionId ? (
          <div className="messages-list">
            {timelineItems.length === 0 && (
              <div className="empty-chat">
                <h3>{selectedCollection?.name || "Collection"}</h3>
                <p>{syncMessage}</p>
                <span>Start by typing a message or attaching a file.</span>
              </div>
            )}
            {timelineItems.map((item) => {
              if (item.kind === "note") {
                return (
                  <div key={item.id} className={`message-row ${item.payload.createdBy === deviceId ? 'me' : 'them'}`}>
                    <article className="bubble bubble-note">
                      <div className="bubble-title">{item.payload.createdBy === deviceId ? "Me" : "Member"}</div>
                      {editingMessageId === item.payload.id ? (
                        <textarea autoFocus className="message-edit-input" value={editingMessageText} onChange={(e) => setEditingMessageText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEditedMessage(item.payload.id); } if (e.key === "Escape") cancelEditingMessage(); }} />
                      ) : (
                        <p>{item.payload.text}</p>
                      )}
                      <time>
                        {new Date(item.payload.createdAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                        {item.payload.editedAt ? " • edited" : ""}
                      </time>
                      <div className="note-actions">
                         <button className="icon-btn copy-btn" onClick={() => copyText(item.payload.text)} title="Copy Text">📋</button>
                        {
                          editingMessageId === item.payload.id ? (
                            <>
                              {canWrite && <button className="icon-btn" onClick={() => saveEditedMessage(item.payload.id)}>✓</button>}
                              <button className="icon-btn" onClick={cancelEditingMessage}>✕</button>
                            </>
                          ) : (
                            <>
                              {canWrite && <button className="icon-btn" onClick={() => startEditingMessage(item.payload)}>✎</button>}
                              {canWrite && <button className="icon-btn danger" onClick={() => deleteMessage(item.payload.id)}>🗑</button>}
                            </>
                          )
                        }
                      </div>
                    </article>
                  </div>
                );
              }
              if (item.kind === "pending") {
                const pendingProgress = uploadProgress?.kind === "pending" && uploadProgress?.id === item.payload.id
                  ? uploadProgress
                  : null;
                return (
                 <div key={item.id} className="message-row me">
                    <article className="bubble bubble-pending">
                      <div className="bubble-title">Pending upload</div>
                      <p>{item.payload.name}</p>
                      <time>{readableBytes(item.payload.size)}</time>
                      {pendingProgress && (
                        <div className="upload-progress">
                          <div className="upload-progress-label">
                            <span>{pendingProgress.percent}%</span>
                            <span>{readableBytes(pendingProgress.loaded)} / {readableBytes(pendingProgress.total || item.payload.size)}</span>
                          </div>
                          <div className="upload-progress-track">
                            <span style={{ width: `${pendingProgress.percent}%` }} />
                          </div>
                        </div>
                      )}
                    </article>
                  </div>
                );
              }
              const file = item.payload;
              return (
                <div key={file._id} className={`message-row ${file.uploadedBy === deviceId ? 'me' : 'them'}`}>
                  <article className="bubble bubble-file">
                    <div className="bubble-title">File</div>
                    {renamingFileId === file._id ? (
                      <input autoFocus type="text" className="file-rename-input" value={renamingFileName} onChange={(e) => setRenamingFileName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") renameFile(file._id); if (e.key === "Escape") setRenamingFileId(null); }} />
                    ) : (
                      <a href={`${BASE_URL}${file.downloadUrl}`} target="_blank" rel="noreferrer" className="file-link">{file.displayName}</a>
                    )}
                    <div className="file-line">
                      <time>{new Date(file.uploadedAt).toLocaleString([], {dateStyle:'short', timeStyle:'short'})}</time>
                      <span>{readableBytes(file.size)}</span>
                    </div>
                    <div className="file-actions">
                      <a
                        className="icon-btn"
                        href={`${BASE_URL}${file.downloadUrl}`}
                        download={file.displayName || file.originalName}
                        title="Download"
                      >
                        ⬇
                      </a>
                    </div>
                    {file.uploadedBy === deviceId && (canWrite || canDelete) && (
                      <div className="file-actions">
                        {renamingFileId === file._id ? (
                          <>
                            {canWrite && <button className="icon-btn" onClick={() => renameFile(file._id)}>✓</button>}
                            <button className="icon-btn" onClick={() => setRenamingFileId(null)}>✕</button>
                          </>
                        ) : (
                          canWrite ? <button className="icon-btn" onClick={() => { setRenamingFileId(file._id); setRenamingFileName(file.displayName); }}>✎</button> : null
                        )}
                        {canDelete && <button className="icon-btn danger" onClick={() => deleteFile(file._id)}>🗑</button>}
                      </div>
                    )}
                  </article>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="empty-chat full"><h3>No collection selected</h3></div>
        )}
      </main>

      <footer className="composer-shell">
        {selectedFile && (
          <div className="attachment-preview">
            <span>{selectedFile.name}</span>
            {uploadProgress?.kind === "direct" && (
              <div className="upload-progress">
                <div className="upload-progress-label">
                  <span>{uploadProgress.percent}%</span>
                  <span>{readableBytes(uploadProgress.loaded)} / {readableBytes(uploadProgress.total || selectedFile.size)}</span>
                </div>
                <div className="upload-progress-track">
                  <span style={{ width: `${uploadProgress.percent}%` }} />
                </div>
              </div>
            )}
            <button onClick={() => setSelectedFile(null)}>✕</button>
          </div>
        )}
        <div className="composer-bar">
          <textarea
            placeholder="Type a message..."
            value={composerText}
            onChange={(e) => setComposerText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (isMobile || e.shiftKey) { /* Allow newline */ }
                else { e.preventDefault(); sendMessage(); }
              }
            }}
            disabled={!selectedCollectionId}
          />
          <button className="send-btn" onClick={sendMessage} disabled={(!composerText.trim() && !selectedFile) || isUploading || !selectedCollectionId || !canWrite}>➤</button>
          <button className="attach-btn" onClick={() => setIsAttachmentOpen(p => !p)} disabled={!selectedCollectionId || !canWrite}>+</button>
          
          <div className={`attachment-surface ${isAttachmentOpen ? "open" : ""}`}>
             <div className="attachment-header">
                <span>Attach</span>
                <button className="attachment-close" onClick={() => setIsAttachmentOpen(false)}>✕</button>
             </div>
             <div className="attach-option" onClick={() => imagesInputRef.current?.click()}><span className="attach-icon">📷</span> Photos</div>
             <div className="attach-option" onClick={() => docsInputRef.current?.click()}><span className="attach-icon">📄</span> Docs</div>
             <div className="attach-option" onClick={() => videosInputRef.current?.click()}><span className="attach-icon">🎥</span> Videos</div>
          </div>
          
           {/* Hidden inputs */}
          <input ref={imagesInputRef} type="file" accept="image/*" style={{display:'none'}} onChange={(e) => {setSelectedFile(e.target.files?.[0]); setIsAttachmentOpen(false); e.target.value='';}} />
          <input ref={docsInputRef} type="file" accept=".pdf,.doc,.docx,.txt" style={{display:'none'}} onChange={(e) => {setSelectedFile(e.target.files?.[0]); setIsAttachmentOpen(false); e.target.value='';}} />
          <input ref={videosInputRef} type="file" accept="video/*" style={{display:'none'}} onChange={(e) => {setSelectedFile(e.target.files?.[0]); setIsAttachmentOpen(false); e.target.value='';}} />

        </div>
      </footer>
      
      {/* Admin Panel Modal */}
      {isAdmin && isAdminModalOpen && (
        <div className="admin-modal-wrapper">
           <div className="admin-modal">
              <div className="admin-header">
                 <h3>Admin Dashboard</h3>
                 <button className="admin-close" onClick={()=>setIsAdminModalOpen(false)}>×</button>
              </div>
              <div className="admin-tabs">
                 <button className={`admin-tab ${adminTab === 'devices' ? 'active' : ''}`} onClick={()=>setAdminTab('devices')}>Devices</button>
                  <button className={`admin-tab ${adminTab === 'requests' ? 'active' : ''}`} onClick={()=>setAdminTab('requests')}>Requests</button>
                  <button className={`admin-tab ${adminTab === 'permissions' ? 'active' : ''}`} onClick={()=>setAdminTab('permissions')}>Manage Access</button>
                  <button className={`admin-tab ${adminTab === 'tracking' ? 'active' : ''}`} onClick={()=>setAdminTab('tracking')}>User Tracking</button>
                 <button className={`admin-tab ${adminTab === 'audit' ? 'active' : ''}`} onClick={()=>setAdminTab('audit')}>Audit Log</button>
              </div>
              <div className="admin-content">
                  {adminTab === 'devices' && adminDevices.map(d => (
                    <div className="device-row" key={d.deviceId}>
                       <div className="device-info">
                          <h4>{d.name} {d.isAdmin ? '👑' : ''} {d.deviceId === deviceId ? '(You)' : ''}</h4>
                          <span>ID: {d.deviceId.substring(0,8)}... | Status: <strong className={`device-status ${d.status}`}>{d.status}</strong></span>
                       </div>
                       {!d.isAdmin && (
                         <div className="audit-actions">
                            {d.status !== 'approved' && <button className="btn-small approve" onClick={()=>approveDevice(d.deviceId)}>Approve</button>}
                            {d.status !== 'rejected' && <button className="btn-small revoke" onClick={()=>revokeDevice(d.deviceId)}>Revoke</button>}
                         </div>
                       )}
                    </div>
                 ))}

                  {adminTab === 'requests' && adminDevices.filter((d) => !d.isAdmin && d.status === 'pending').map(d => (
                    <div className="device-row" key={d.deviceId}>
                      <div className="device-info">
                        <h4>{d.name}</h4>
                        <span>ID: {d.deviceId.substring(0,8)}... | Requested: {new Date(d.updatedAt || d.createdAt).toLocaleString()}</span>
                      </div>
                      <div className="audit-actions">
                        <button className="btn-small approve" onClick={()=>approveDevice(d.deviceId)}>Approve</button>
                        <button className="btn-small revoke" onClick={()=>revokeDevice(d.deviceId)}>Reject</button>
                      </div>
                    </div>
                  ))}
                  {adminTab === 'requests' && adminDevices.filter((d) => !d.isAdmin && d.status === 'pending').length === 0 && <p style={{textAlign:'center', color:'#6a5a4e'}}>No pending requests.</p>}

                   {adminTab === 'permissions' && adminDevices.filter((d) => !d.isAdmin).map(d => {
                    const p = {
                     canRead: d.permissions?.canRead !== false,
                     canWrite: d.permissions?.canWrite !== false,
                     canDelete: d.permissions?.canDelete !== false,
                    };
                      const disabled = updatingPermissionFor === d.deviceId || removingDeviceId === d.deviceId || d.status !== 'approved';
                    return (
                     <div className="device-row permissions-row" key={d.deviceId}>
                      <div className="device-info">
                        <h4>{d.name}</h4>
                            <span>ID: {d.deviceId.substring(0,8)}... | Status: <strong className={`device-status ${d.status}`}>{d.status}</strong></span>
                      </div>
                      <div className="permission-controls">
                        <label>
                         <input type="checkbox" checked={p.canRead} disabled={disabled} onChange={(e) => updateDevicePermission(d, "canRead", e.target.checked)} />
                         Read
                        </label>
                        <label>
                         <input type="checkbox" checked={p.canWrite} disabled={disabled} onChange={(e) => updateDevicePermission(d, "canWrite", e.target.checked)} />
                         Write
                        </label>
                        <label>
                         <input type="checkbox" checked={p.canDelete} disabled={disabled} onChange={(e) => updateDevicePermission(d, "canDelete", e.target.checked)} />
                         Delete
                        </label>
                          <button className="btn-small revoke" onClick={() => revokeDevice(d.deviceId)} disabled={removingDeviceId === d.deviceId || d.status === 'rejected'}>Revoke</button>
                          <button className="btn-small remove" onClick={() => removeDevice(d.deviceId)} disabled={removingDeviceId === d.deviceId}>{removingDeviceId === d.deviceId ? 'Removing...' : 'Remove User'}</button>
                      </div>
                     </div>
                    );
                  })}
                 {adminTab === 'permissions' && adminDevices.filter((d) => !d.isAdmin).length === 0 && <p style={{textAlign:'center', color:'#6a5a4e'}}>No users available for permission management.</p>}

                 {adminTab === 'tracking' && adminUserTracking.map((u) => (
                    <div className="audit-row tracking-row" key={u.deviceId}>
                      <div className="audit-info">
                        <h4>{u.name} <span style={{color:'#db9f75'}}>{u.status}</span></h4>
                        <span>
                          Last activity: {u.lastActivityAt ? new Date(u.lastActivityAt).toLocaleString() : "No activity"}
                        </span>
                      </div>
                      <div className="tracking-stats">
                        <span>Events: {u.totalEvents}</span>
                        <span>Uploads: {u.uploads}</span>
                        <span>Notes+: {u.createdNotes}</span>
                        <span>Edits: {u.editedNotes}</span>
                        <span>Deletes: {u.deletedItems}</span>
                      </div>
                    </div>
                 ))}
                 {adminTab === 'tracking' && adminUserTracking.length === 0 && <p style={{textAlign:'center', color:'#6a5a4e'}}>No user activity yet.</p>}
                 
                 {adminTab === 'audit' && adminAudits.map(a => (
                    <div className="audit-row" key={a._id}>
                       <div className="audit-info">
                          <h4>{a.deviceName} <span style={{color:'#db9f75'}}>{a.action.replace('_', ' ')}</span></h4>
                          <span>{a.details?.fileName || a.details?.snippet || 'Item'} • {new Date(a.createdAt).toLocaleString()}</span>
                       </div>
                       {(a.action.startsWith('deleted_')) && (
                          <div className="audit-actions">
                            <button className="btn-small undo" onClick={()=>undoLog(a._id)}>Retain</button>
                            <button className="btn-small delete" onClick={()=>permanentDeleteLog(a._id)}>Permanently Delete</button>
                          </div>
                       )}
                    </div>
                 ))}
                 {adminTab === 'audit' && adminAudits.length === 0 && <p style={{textAlign:'center', color:'#6a5a4e'}}>No audit logs yet.</p>}
              </div>
           </div>
        </div>
      )}
    </div>
  );
}

export default App;