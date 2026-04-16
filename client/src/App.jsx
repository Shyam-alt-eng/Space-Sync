import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { io } from "socket.io-client";
import {
  addPendingUpload,
  cacheCollections,
  getCachedCollections,
  addCachedCollection,
  removeCachedCollection,
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
  : window.location.origin;
const BASE_URL = import.meta.env.VITE_API_URL || DEFAULT_API_URL;
const api = axios.create({ baseURL: BASE_URL });

const socket = io(BASE_URL, {
  transports: ["websocket", "polling"],
});

const NOTES_STORAGE_KEY = "spacesync-notes-v1";

const readableBytes = (bytes) => {
  if (!bytes && bytes !== 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

function App() {
  const [collections, setCollections] = useState([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState(null);
  const [files, setFiles] = useState([]);
  const [pendingUploads, setPendingUploads] = useState([]);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [isUploading, setIsUploading] = useState(false);
  const [syncMessage, setSyncMessage] = useState("Ready");
  const [selectedFile, setSelectedFile] = useState(null);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [isCollectionMenuOpen, setIsCollectionMenuOpen] = useState(false);
  const [isCreateCollectionOpen, setIsCreateCollectionOpen] = useState(false);
  const [isAttachmentOpen, setIsAttachmentOpen] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [notesByCollection, setNotesByCollection] = useState({});
  const [renamingFileId, setRenamingFileId] = useState(null);
  const [renamingFileName, setRenamingFileName] = useState("");
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [editingMessageText, setEditingMessageText] = useState("");
  const [renamingCollectionId, setRenamingCollectionId] = useState(null);
  const [renamingCollectionName, setRenamingCollectionName] = useState("");
  const collectionInputRef = useRef(null);
  const imagesInputRef = useRef(null);
  const docsInputRef = useRef(null);
  const videosInputRef = useRef(null);
  const captureInputRef = useRef(null);
  const selectedCollection = collections.find((c) => c._id === selectedCollectionId);
  const currentNotes = notesByCollection[selectedCollectionId] || [];
  const currentPending = pendingUploads.filter(
    (pending) => pending.collectionId === selectedCollectionId
  );

  const timelineItems = useMemo(() => {
    const noteItems = currentNotes.map((note) => ({
      kind: "note",
      id: note.id,
      ts: new Date(note.createdAt).getTime(),
      payload: note,
    }));

    const pendingItems = currentPending.map((pending) => ({
      kind: "pending",
      id: pending.id,
      ts: new Date(pending.createdAt || Date.now()).getTime(),
      payload: pending,
    }));

    const fileItems = files.map((file) => ({
      kind: "file",
      id: file._id,
      ts: new Date(file.uploadedAt).getTime(),
      payload: file,
    }));

    return [...noteItems, ...pendingItems, ...fileItems].sort((a, b) => a.ts - b.ts);
  }, [currentNotes, currentPending, files]);

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
      } else if (
        selectedCollectionId &&
        !res.data.some((collection) => collection._id === selectedCollectionId)
      ) {
        setSelectedCollectionId(res.data[0]?._id || null);
      }

      setSyncMessage("Collections synced");
    } catch (error) {
      await hydrateFromCache();
      setSyncMessage("Showing cached collections");
    }
  };

  const fetchFilesForCollection = async (collectionId) => {
    if (!collectionId) return;

    try {
      const res = await api.get(`/collections/${collectionId}/files`);
      setFiles(res.data);
      await cacheFilesForCollection(collectionId, res.data);
      setSyncMessage(`Synced ${res.data.length} files`);
    } catch (error) {
      const cachedFiles = await getCachedFilesForCollection(collectionId);
      setFiles(cachedFiles);
      setSyncMessage("Showing cached files");
    }
  };

  const createCollection = async () => {
    if (!newCollectionName.trim()) return;

    try {
      const res = await api.post("/collections", { name: newCollectionName });
      setCollections((prev) => [res.data, ...prev]);
      await addCachedCollection(res.data);
      setNewCollectionName("");
      setSelectedCollectionId(res.data._id);
      setFiles([]);
      setIsCreateCollectionOpen(false);
      setIsCollectionMenuOpen(false);
      setSyncMessage("Collection created");
    } catch (error) {
      setSyncMessage("Failed to create collection");
    }
  };

  const deleteCollection = async (collectionId) => {
    try {
      await api.delete(`/collections/${collectionId}`);
      setCollections((prev) => prev.filter((c) => c._id !== collectionId));
      await removeCachedCollection(collectionId);

      if (selectedCollectionId === collectionId) {
        if (collections.length > 1) {
          const newSelected = collections.find((c) => c._id !== collectionId);
          setSelectedCollectionId(newSelected._id);
        } else {
          setSelectedCollectionId(null);
          setFiles([]);
        }
      }
    } catch (error) {
      setSyncMessage("Failed to delete collection");
    }
  };

  const renameCollection = async (collectionId) => {
    if (!renamingCollectionName.trim() || renamingCollectionId !== collectionId) return;

    try {
      const res = await api.patch(`/collections/${collectionId}`, {
        name: renamingCollectionName,
      });
      setCollections((prev) =>
        prev.map((c) => (c._id === collectionId ? res.data : c))
      );
      await addCachedCollection(res.data);
      setRenamingCollectionId(null);
      setRenamingCollectionName("");
      setSyncMessage("Collection renamed");
    } catch (error) {
      setSyncMessage("Failed to rename collection");
    }
  };

  const uploadFile = async (fileToUpload) => {
    if (!fileToUpload || !selectedCollectionId) return;

    if (!isOnline) {
      const queued = await addPendingUpload(fileToUpload, selectedCollectionId);
      setPendingUploads((prev) => [queued, ...prev]);
      setSelectedFile(null);
      setSyncMessage("File queued for upload");
      return;
    }

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", fileToUpload);
      const res = await api.post(
        `/collections/${selectedCollectionId}/upload`,
        formData
      );
      setFiles((prev) => {
        const deduped = prev.filter((f) => f._id !== res.data._id);
        return [res.data, ...deduped];
      });
      await upsertCachedFile(res.data);
      setSelectedFile(null);
      setSyncMessage("Upload complete");
    } catch (error) {
      const queued = await addPendingUpload(fileToUpload, selectedCollectionId);
      setPendingUploads((prev) => [queued, ...prev]);
      setSyncMessage("Network issue. File queued for upload");
    } finally {
      setIsUploading(false);
    }
  };

  const deleteFile = async (fileId) => {
    try {
      await api.delete(`/files/${fileId}`);
      setFiles((prev) => prev.filter((f) => f._id !== fileId));
      await removeCachedFile(fileId);
      if (renamingFileId === fileId) {
        setRenamingFileId(null);
        setRenamingFileName("");
      }
      setSyncMessage("File deleted");
    } catch (error) {
      setSyncMessage("Failed to delete file");
    }
  };

  const renameFile = async (fileId) => {
    if (!renamingFileName.trim() || renamingFileId !== fileId) return;

    try {
      const res = await api.patch(`/files/${fileId}`, {
        displayName: renamingFileName.trim(),
      });
      setFiles((prev) => prev.map((file) => (file._id === fileId ? res.data : file)));
      await upsertCachedFile(res.data);
      setRenamingFileId(null);
      setRenamingFileName("");
      setSyncMessage("File renamed");
    } catch (error) {
      setSyncMessage("Failed to rename file");
    }
  };

  const syncPendingUploads = async () => {
    const queued = await getPendingUploads();
    if (queued.length === 0) return;

    setSyncMessage(`Syncing ${queued.length} pending files...`);

    for (const pending of queued) {
      try {
        const formData = new FormData();
        formData.append("file", pending.blob, pending.name);
        await api.post(`/collections/${pending.collectionId}/upload`, formData);
        await removePendingUpload(pending.id);
      } catch (error) {
        setSyncMessage("Some pending files failed to sync");
      }
    }

    const latestPending = await getPendingUploads();
    setPendingUploads(latestPending);
    if (latestPending.length === 0) {
      setSyncMessage("All pending files synced");
    }
  };

  const sendMessage = async () => {
    if (!selectedCollectionId) {
      setSyncMessage("Create a collection first");
      return;
    }

    const trimmed = composerText.trim();
    if (!trimmed && !selectedFile) return;

    if (trimmed) {
      const newNote = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        text: trimmed,
        createdAt: new Date().toISOString(),
      };
      setNotesByCollection((prev) => ({
        ...prev,
        [selectedCollectionId]: [...(prev[selectedCollectionId] || []), newNote],
      }));
      setComposerText("");
    }

    if (selectedFile) {
      await uploadFile(selectedFile);
    }

    setIsAttachmentOpen(false);
  };

  const selectAttachmentCategory = (kind) => {
    const map = {
      images: imagesInputRef,
      documents: docsInputRef,
      videos: videosInputRef,
      capture: captureInputRef,
    };
    map[kind]?.current?.click();
  };

  const onPickAttachmentFile = (event) => {
    const file = event.target.files?.[0] || null;
    setSelectedFile(file);
    event.target.value = "";
    setIsAttachmentOpen(false);
  };

  const startEditingMessage = (note) => {
    setEditingMessageId(note.id);
    setEditingMessageText(note.text);
  };

  const cancelEditingMessage = () => {
    setEditingMessageId(null);
    setEditingMessageText("");
  };

  const saveEditedMessage = (messageId) => {
    const trimmed = editingMessageText.trim();
    if (!selectedCollectionId) return;

    if (!trimmed) {
      setNotesByCollection((prev) => ({
        ...prev,
        [selectedCollectionId]: (prev[selectedCollectionId] || []).filter(
          (note) => note.id !== messageId
        ),
      }));
      cancelEditingMessage();
      setSyncMessage("Message deleted");
      return;
    }

    setNotesByCollection((prev) => ({
      ...prev,
      [selectedCollectionId]: (prev[selectedCollectionId] || []).map((note) =>
        note.id === messageId
          ? { ...note, text: trimmed, editedAt: new Date().toISOString() }
          : note
      ),
    }));
    cancelEditingMessage();
    setSyncMessage("Message updated");
  };

  const deleteMessage = (messageId) => {
    if (!selectedCollectionId) return;

    setNotesByCollection((prev) => ({
      ...prev,
      [selectedCollectionId]: (prev[selectedCollectionId] || []).filter(
        (note) => note.id !== messageId
      ),
    }));

    if (editingMessageId === messageId) {
      cancelEditingMessage();
    }

    setSyncMessage("Message deleted");
  };

  useEffect(() => {
    const savedNotes = localStorage.getItem(NOTES_STORAGE_KEY);
    if (savedNotes) {
      try {
        setNotesByCollection(JSON.parse(savedNotes));
      } catch {
        setNotesByCollection({});
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(notesByCollection));
  }, [notesByCollection]);

  useEffect(() => {
    const onEscape = (event) => {
      if (event.key === "Escape") {
        setIsAttachmentOpen(false);
        setIsCollectionMenuOpen(false);
      }
    };

    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, []);

  useEffect(() => {
    if (isCreateCollectionOpen) {
      collectionInputRef.current?.focus();
    }
  }, [isCreateCollectionOpen]);

  useEffect(() => {
    const onOnline = async () => {
      setIsOnline(true);
      await syncPendingUploads();
      await fetchCollections();
      if (selectedCollectionId) {
        await fetchFilesForCollection(selectedCollectionId);
      }
    };

    const onOffline = () => {
      setIsOnline(false);
      setSyncMessage("Offline mode active");
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [selectedCollectionId]);

  useEffect(() => {
    const upsertIncomingFile = async (newFile) => {
      if (newFile.collectionId === selectedCollectionId) {
        setFiles((prev) => {
          const deduped = prev.filter((f) => f._id !== newFile._id);
          return [newFile, ...deduped];
        });
        await upsertCachedFile(newFile);
      }
    };

    socket.on("file:created", upsertIncomingFile);
    socket.on("file:renamed", upsertIncomingFile);
    socket.on("file:deleted", ({ _id }) => {
      setFiles((prev) => prev.filter((f) => f._id !== _id));
      removeCachedFile(_id);
    });

    hydrateFromCache();
    fetchCollections();

    return () => {
      socket.off("file:created", upsertIncomingFile);
      socket.off("file:renamed");
      socket.off("file:deleted");
    };
  }, [selectedCollectionId]);

  useEffect(() => {
    if (selectedCollectionId) {
      fetchFilesForCollection(selectedCollectionId);
    }
  }, [selectedCollectionId]);

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className={`collection-dropdown ${isCollectionMenuOpen ? "open" : ""}`}>
          <button
            className="dropdown-trigger"
            onClick={() => setIsCollectionMenuOpen((prev) => !prev)}
            aria-label="Open collections"
          >
            <span>{selectedCollection?.name || "My Collection"}</span>
            <span className="caret">▾</span>
          </button>

          {isCollectionMenuOpen && (
            <div className="dropdown-menu">
              <div className="menu-list">
                {collections.map((col) => (
                  <div
                    key={col._id}
                    className={`menu-item ${selectedCollectionId === col._id ? "active" : ""}`}
                    onClick={() => {
                      setSelectedCollectionId(col._id);
                      setIsCollectionMenuOpen(false);
                    }}
                  >
                    {renamingCollectionId === col._id ? (
                      <input
                        autoFocus
                        type="text"
                        value={renamingCollectionName}
                        onChange={(event) => setRenamingCollectionName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") renameCollection(col._id);
                          if (event.key === "Escape") setRenamingCollectionId(null);
                        }}
                        onClick={(event) => event.stopPropagation()}
                      />
                    ) : (
                      <span
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          setRenamingCollectionId(col._id);
                          setRenamingCollectionName(col.name);
                        }}
                      >
                        {col.name}
                      </span>
                    )}

                    <button
                      className="menu-delete"
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteCollection(col._id);
                      }}
                      title="Delete collection"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>

              {isCreateCollectionOpen ? (
                <div className="create-collection-inline">
                  <input
                    ref={collectionInputRef}
                    type="text"
                    placeholder="Collection name"
                    value={newCollectionName}
                    onChange={(event) => setNewCollectionName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") createCollection();
                      if (event.key === "Escape") {
                        setIsCreateCollectionOpen(false);
                        setNewCollectionName("");
                      }
                    }}
                  />
                  <button onClick={createCollection} disabled={!newCollectionName.trim()}>
                    Create
                  </button>
                </div>
              ) : (
                <button
                  className="menu-create"
                  onClick={() => {
                    setIsCreateCollectionOpen(true);
                    setNewCollectionName("");
                  }}
                >
                  + Create New Collection
                </button>
              )}
            </div>
          )}
        </div>

        <div className="top-status">
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
                  <div key={item.id} className="message-row me">
                    <article className="bubble bubble-note">
                      {editingMessageId === item.payload.id ? (
                        <input
                          autoFocus
                          type="text"
                          className="message-edit-input"
                          value={editingMessageText}
                          onChange={(event) => setEditingMessageText(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              saveEditedMessage(item.payload.id);
                            }
                            if (event.key === "Escape") {
                              cancelEditingMessage();
                            }
                          }}
                        />
                      ) : (
                        <p>{item.payload.text}</p>
                      )}
                      <time>
                        {new Date(item.payload.createdAt).toLocaleTimeString()}
                        {item.payload.editedAt ? " • edited" : ""}
                      </time>
                      <div className="note-actions">
                        {editingMessageId === item.payload.id ? (
                          <>
                            <button
                              className="icon-btn"
                              onClick={() => saveEditedMessage(item.payload.id)}
                              title="Save message"
                            >
                              ✓
                            </button>
                            <button
                              className="icon-btn"
                              onClick={cancelEditingMessage}
                              title="Cancel edit"
                            >
                              ✕
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className="icon-btn"
                              onClick={() => startEditingMessage(item.payload)}
                              title="Edit message"
                            >
                              ✎
                            </button>
                            <button
                              className="icon-btn danger"
                              onClick={() => deleteMessage(item.payload.id)}
                              title="Delete message"
                            >
                              🗑
                            </button>
                          </>
                        )}
                      </div>
                    </article>
                  </div>
                );
              }

              if (item.kind === "pending") {
                return (
                  <div key={item.id} className="message-row them">
                    <article className="bubble bubble-pending">
                      <div className="bubble-title">Pending upload</div>
                      <p>{item.payload.name}</p>
                      <time>{readableBytes(item.payload.size)}</time>
                    </article>
                  </div>
                );
              }

              const file = item.payload;
              return (
                <div key={file._id} className="message-row them">
                  <article className="bubble bubble-file">
                    <div className="bubble-title">File</div>
                    {renamingFileId === file._id ? (
                      <input
                        autoFocus
                        type="text"
                        className="file-rename-input"
                        value={renamingFileName}
                        onChange={(event) => setRenamingFileName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            renameFile(file._id);
                          }
                          if (event.key === "Escape") {
                            setRenamingFileId(null);
                            setRenamingFileName("");
                          }
                        }}
                      />
                    ) : (
                      <a
                        href={`${BASE_URL}${file.downloadUrl}`}
                        target="_blank"
                        rel="noreferrer"
                        className="file-link"
                      >
                        {file.displayName}
                      </a>
                    )}
                    <div className="file-line">
                      <time>{new Date(file.uploadedAt).toLocaleString()}</time>
                      <span>{readableBytes(file.size)}</span>
                    </div>
                    <div className="file-actions">
                      {renamingFileId === file._id ? (
                        <>
                          <button className="icon-btn" onClick={() => renameFile(file._id)} title="Save rename">
                            ✓
                          </button>
                          <button
                            className="icon-btn"
                            onClick={() => {
                              setRenamingFileId(null);
                              setRenamingFileName("");
                            }}
                            title="Cancel rename"
                          >
                            ✕
                          </button>
                        </>
                      ) : (
                        <button
                          className="icon-btn"
                          onClick={() => {
                            setRenamingFileId(file._id);
                            setRenamingFileName(file.displayName);
                          }}
                          title="Rename"
                        >
                          ✎
                        </button>
                      )}
                      <button className="icon-btn danger" onClick={() => deleteFile(file._id)} title="Delete">
                        🗑
                      </button>
                    </div>
                  </article>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="empty-chat full">
            <h3>No collection selected</h3>
            <p>Create a collection to start.</p>
          </div>
        )}
      </main>

      <footer className="composer-shell">
        {selectedFile && (
          <div className="attachment-preview">
            <span>{selectedFile.name}</span>
            <button onClick={() => setSelectedFile(null)} title="Remove selected file">
              ✕
            </button>
          </div>
        )}

        <div className="composer-bar">
          <input
            type="text"
            placeholder="Type something"
            value={composerText}
            onChange={(event) => setComposerText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") sendMessage();
            }}
            disabled={!selectedCollectionId}
          />
          <button
            className="send-btn"
            onClick={sendMessage}
            disabled={(!composerText.trim() && !selectedFile) || isUploading || !selectedCollectionId}
            title="Send"
          >
            ➤
          </button>
          <button
            className="attach-btn"
            onClick={() => setIsAttachmentOpen((prev) => !prev)}
            disabled={!selectedCollectionId}
            title="Add attachment"
          >
            +
          </button>
        </div>

        {isAttachmentOpen && (
          <button
            type="button"
            className="attachment-backdrop"
            onClick={() => setIsAttachmentOpen(false)}
            aria-label="Close attachment options"
          />
        )}

        <div className={`attachment-surface ${isAttachmentOpen ? "open" : ""}`}>
          <div className="attachment-header">
            <span>Attach file</span>
            <button
              type="button"
              className="attachment-close"
              onClick={() => setIsAttachmentOpen(false)}
              aria-label="Close attachment options"
            >
              ✕
            </button>
          </div>
          <button className="attach-option" onClick={() => selectAttachmentCategory("images")}>
            <span className="attach-icon">🖼</span>
            <span>Images</span>
          </button>
          <button className="attach-option" onClick={() => selectAttachmentCategory("documents")}>
            <span className="attach-icon">📄</span>
            <span>Documents</span>
          </button>
          <button className="attach-option" onClick={() => selectAttachmentCategory("videos")}>
            <span className="attach-icon">🎬</span>
            <span>Videos</span>
          </button>
          <button className="attach-option" onClick={() => selectAttachmentCategory("capture")}>
            <span className="attach-icon">📷</span>
            <span>Capture</span>
          </button>
        </div>

        <input ref={imagesInputRef} type="file" accept="image/*" hidden onChange={onPickAttachmentFile} />
        <input
          ref={docsInputRef}
          type="file"
          accept=".pdf,.doc,.docx,.ppt,.pptx,.txt"
          hidden
          onChange={onPickAttachmentFile}
        />
        <input ref={videosInputRef} type="file" accept="video/*" hidden onChange={onPickAttachmentFile} />
        <input
          ref={captureInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={onPickAttachmentFile}
        />
      </footer>
    </div>
  );
}

export default App;