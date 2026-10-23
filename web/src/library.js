import { assertMediaFits, getMediaCapacityState } from "./media-capacity.js";

const DATABASE_NAME = "puffin-library";
const DATABASE_VERSION = 2;
const TRACKS_STORE = "tracks";
const FILES_STORE = "files";
const PLAYLISTS_STORE = "playlists";
const MEDIA_STORAGE_LIMIT_KEY = "puffin.mediaStorageLimitBytes";
export const DEFAULT_MEDIA_STORAGE_LIMIT_BYTES = 10 * 1024 ** 3;

let databasePromise;

export function getMediaStorageLimit() {
  try {
    const savedLimit = Number(localStorage.getItem(MEDIA_STORAGE_LIMIT_KEY));
    if (Number.isFinite(savedLimit) && savedLimit > 0) return savedLimit;
  } catch {
    // Use Puffin's default when local preferences are unavailable.
  }
  return DEFAULT_MEDIA_STORAGE_LIMIT_BYTES;
}

export function setMediaStorageLimit(bytes) {
  if (!Number.isFinite(bytes) || bytes < 100 * 1024 ** 2 || bytes > 1000 * 1024 ** 3) {
    throw new Error("Choose a media storage limit between 0.1 and 1000 GB.");
  }
  try {
    localStorage.setItem(MEDIA_STORAGE_LIMIT_KEY, String(bytes));
  } catch {
    throw new Error("Puffin could not save this setting in browser storage.");
  }
}
const MIME_TYPES_BY_EXTENSION = {
  aac: "audio/aac",
  aiff: "audio/aiff",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/opus",
  wav: "audio/wav",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp4: "video/mp4",
  m4v: "video/mp4",
  ogv: "video/ogg",
  webm: "video/webm",
};

function openDatabase() {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(TRACKS_STORE)) {
        database.createObjectStore(TRACKS_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(FILES_STORE)) {
        database.createObjectStore(FILES_STORE);
      }
      if (!database.objectStoreNames.contains(PLAYLISTS_STORE)) {
        database.createObjectStore(PLAYLISTS_STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };

    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Puffin's library database is blocked by another open tab."));
  }).catch((error) => {
    databasePromise = undefined;
    throw error;
  });

  return databasePromise;
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("The library transaction failed."));
    transaction.onabort = () => reject(transaction.error || new Error("The library transaction was cancelled."));
  });
}

export function getMediaKind(fileName, mimeType = "") {
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";

  const extension = fileName.split(".").pop()?.toLowerCase();
  const videoExtensions = new Set(["mp4", "m4v", "mov", "webm", "ogv", "mkv", "avi"]);
  const audioExtensions = new Set(["mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "aiff"]);

  if (videoExtensions.has(extension)) return "video";
  if (audioExtensions.has(extension)) return "audio";
  return null;
}

function getMediaMimeType(fileName, mimeType = "") {
  if (mimeType && mimeType !== "application/octet-stream") return mimeType;
  const extension = fileName.split(".").pop()?.toLowerCase();
  return MIME_TYPES_BY_EXTENSION[extension] || mimeType || "application/octet-stream";
}

export async function saveMediaFile(file, metadata = {}) {
  const database = await openDatabase();
  const id = crypto.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const name = metadata.name || file.name || "Puffin download";
  const mimeType = metadata.type || file.type;
  const record = {
    id,
    name,
    type: getMediaMimeType(name, mimeType),
    kind: getMediaKind(name, mimeType),
    size: file.size,
    lastModified: file.lastModified || Date.now(),
    importedAt: Date.now(),
  };

  const transaction = database.transaction([TRACKS_STORE, FILES_STORE], "readwrite");
  const completion = transactionComplete(transaction);
  const tracksStore = transaction.objectStore(TRACKS_STORE);
  const filesStore = transaction.objectStore(FILES_STORE);
  let capacityError;
  const listRequest = tracksStore.getAll();
  listRequest.onsuccess = () => {
    const currentUsage = listRequest.result.reduce((total, currentRecord) => total + currentRecord.size, 0);
    try {
      assertMediaFits(currentUsage, getMediaStorageLimit(), file.size);
      tracksStore.put(record);
      filesStore.put(file, id);
    } catch (error) {
      capacityError = error;
      transaction.abort();
    }
  };

  try {
    await completion;
  } catch (error) {
    if (capacityError) throw capacityError;
    throw error;
  }
  return record;
}

export async function getMediaStorageCapacity() {
  const records = await listMediaFiles();
  const usedBytes = records.reduce((total, record) => total + record.size, 0);
  return getMediaCapacityState(usedBytes, getMediaStorageLimit());
}

export async function assertMediaStorageCapacity(incomingBytes) {
  const capacity = await getMediaStorageCapacity();
  return assertMediaFits(capacity.usedBytes, capacity.limitBytes, incomingBytes);
}

export async function listMediaFiles() {
  const database = await openDatabase();
  const transaction = database.transaction(TRACKS_STORE, "readonly");
  const request = transaction.objectStore(TRACKS_STORE).getAll();

  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result.sort((first, second) => second.importedAt - first.importedAt));
    };
    request.onerror = () => reject(request.error);
  });
}

export async function getMediaBlob(id) {
  const database = await openDatabase();
  const request = database.transaction(FILES_STORE, "readonly").objectStore(FILES_STORE).get(id);

  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteMediaFile(id) {
  const database = await openDatabase();
  const transaction = database.transaction([TRACKS_STORE, FILES_STORE, PLAYLISTS_STORE], "readwrite");
  const completion = transactionComplete(transaction);
  transaction.objectStore(TRACKS_STORE).delete(id);
  transaction.objectStore(FILES_STORE).delete(id);
  const playlists = transaction.objectStore(PLAYLISTS_STORE);
  const request = playlists.getAll();
  request.onsuccess = () => {
    request.result.forEach((playlist) => {
      if (playlist.mediaIds.includes(id)) {
        playlist.mediaIds = playlist.mediaIds.filter((mediaId) => mediaId !== id);
        playlist.updatedAt = Date.now();
        playlists.put(playlist);
      }
    });
  };
  await completion;
}

export async function listPlaylists() {
  const database = await openDatabase();
  const transaction = database.transaction(PLAYLISTS_STORE, "readonly");
  const request = transaction.objectStore(PLAYLISTS_STORE).getAll();

  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result.sort((first, second) => {
      if (first.pinned !== second.pinned) return Number(second.pinned) - Number(first.pinned);
      return first.createdAt - second.createdAt;
    }));
    request.onerror = () => reject(request.error);
  });
}

async function savePlaylistName(id, name) {
  const normalizedName = name.trim().replace(/\s+/g, " ");
  if (!normalizedName) throw new Error("Enter a playlist name.");

  const database = await openDatabase();
  const transaction = database.transaction(PLAYLISTS_STORE, "readwrite");
  const completion = transactionComplete(transaction);
  const store = transaction.objectStore(PLAYLISTS_STORE);
  const request = store.getAll();
  request.onsuccess = () => {
    const duplicate = request.result.some((playlist) =>
      playlist.id !== id && playlist.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase());
    if (duplicate) {
      transaction.abort();
      return;
    }

    if (id) {
      const playlist = request.result.find((item) => item.id === id);
      if (!playlist) {
        transaction.abort();
        return;
      }
      playlist.name = normalizedName;
      playlist.updatedAt = Date.now();
      store.put(playlist);
    } else {
      const now = Date.now();
      store.add({
        id: crypto.randomUUID?.() || `${now}-${Math.random().toString(36).slice(2)}`,
        name: normalizedName,
        pinned: false,
        mediaIds: [],
        createdAt: now,
        updatedAt: now,
      });
    }
  };

  try {
    await completion;
  } catch (error) {
    if (error?.name === "AbortError") {
      const playlists = await listPlaylists();
      if (playlists.some((playlist) => playlist.id !== id && playlist.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) {
        throw new Error("A playlist with that name already exists.");
      }
      throw new Error("That playlist no longer exists.");
    }
    throw error;
  }
}

export function createPlaylist(name) {
  return savePlaylistName(null, name);
}

export function renamePlaylist(id, name) {
  return savePlaylistName(id, name);
}

export async function deletePlaylist(id) {
  const database = await openDatabase();
  const transaction = database.transaction(PLAYLISTS_STORE, "readwrite");
  const completion = transactionComplete(transaction);
  transaction.objectStore(PLAYLISTS_STORE).delete(id);
  await completion;
}

export async function setPlaylistPinned(id, pinned) {
  const database = await openDatabase();
  const transaction = database.transaction(PLAYLISTS_STORE, "readwrite");
  const completion = transactionComplete(transaction);
  const store = transaction.objectStore(PLAYLISTS_STORE);
  const request = store.get(id);
  request.onsuccess = () => {
    if (!request.result) {
      transaction.abort();
      return;
    }
    request.result.pinned = pinned;
    request.result.updatedAt = Date.now();
    store.put(request.result);
  };
  await completion;
}

export async function addMediaToPlaylist(playlistId, mediaId) {
  const database = await openDatabase();
  const transaction = database.transaction([PLAYLISTS_STORE, TRACKS_STORE], "readwrite");
  const completion = transactionComplete(transaction);
  const playlistStore = transaction.objectStore(PLAYLISTS_STORE);
  const playlistRequest = playlistStore.get(playlistId);
  playlistRequest.onsuccess = () => {
    const playlist = playlistRequest.result;
    if (!playlist) {
      transaction.abort();
      return;
    }
    const mediaRequest = transaction.objectStore(TRACKS_STORE).get(mediaId);
    mediaRequest.onsuccess = () => {
      if (!mediaRequest.result) {
        transaction.abort();
        return;
      }
      if (!playlist.mediaIds.includes(mediaId)) {
        playlist.mediaIds.push(mediaId);
        playlist.updatedAt = Date.now();
        playlistStore.put(playlist);
      }
    };
  };
  await completion;
}

export async function removeMediaFromPlaylist(playlistId, mediaId) {
  const database = await openDatabase();
  const transaction = database.transaction(PLAYLISTS_STORE, "readwrite");
  const completion = transactionComplete(transaction);
  const store = transaction.objectStore(PLAYLISTS_STORE);
  const request = store.get(playlistId);
  request.onsuccess = () => {
    if (!request.result) return;
    request.result.mediaIds = request.result.mediaIds.filter((id) => id !== mediaId);
    request.result.updatedAt = Date.now();
    store.put(request.result);
  };
  await completion;
}
