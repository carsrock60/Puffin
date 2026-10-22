const DATABASE_NAME = "puffin-library";
const DATABASE_VERSION = 1;
const TRACKS_STORE = "tracks";
const FILES_STORE = "files";

let databasePromise;
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
  transaction.objectStore(TRACKS_STORE).put(record);
  transaction.objectStore(FILES_STORE).put(file, id);
  await completion;
  return record;
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
  const transaction = database.transaction([TRACKS_STORE, FILES_STORE], "readwrite");
  const completion = transactionComplete(transaction);
  transaction.objectStore(TRACKS_STORE).delete(id);
  transaction.objectStore(FILES_STORE).delete(id);
  await completion;
}
