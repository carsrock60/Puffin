import {
  deleteMediaFile,
  getMediaBlob,
  getMediaKind,
  listMediaFiles,
  saveMediaFile,
} from "./library.js";
import { initializeDownloader } from "./downloader.js";

const tabButtons = document.querySelectorAll("[data-tab]");
const panels = document.querySelectorAll("[data-panel]");
const homePanel = document.querySelector("#home-panel");

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const selectedTab = button.dataset.tab;

    tabButtons.forEach((tab) => {
      if (tab === button) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    });

    panels.forEach((panel) => {
      panel.hidden = panel.dataset.panel !== selectedTab;
    });

    homePanel.hidden = true;
  });
});

const themeToggle = document.querySelector("#theme-toggle");
themeToggle.addEventListener("click", () => {
  const isDark = document.body.classList.toggle("dark");
  themeToggle.setAttribute("aria-pressed", String(isDark));
});

const importButton = document.querySelector("#import-media");
const filePicker = document.querySelector("#media-files");
const libraryStatus = document.querySelector("#library-status");
const libraryStorage = document.querySelector("#library-storage");
const mediaList = document.querySelector("#media-list");
const mediaPlayer = document.querySelector("#media-player");
const currentMediaTitle = document.querySelector("#current-media-title");
const audioPlayer = document.querySelector("#audio-player");
const videoPlayer = document.querySelector("#video-player");

let activeMediaId = null;
let activeObjectUrl = null;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function setLibraryStatus(message) {
  libraryStatus.textContent = message;
}

async function updateStorageSummary(records) {
  const libraryBytes = records.reduce((total, record) => total + record.size, 0);
  const storage = navigator.storage;

  if (!storage?.estimate) {
    libraryStorage.textContent = `${records.length} ${records.length === 1 ? "file" : "files"} · ${formatBytes(libraryBytes)} in your library`;
    return;
  }

  try {
    const { usage, quota } = await storage.estimate();
    const browserUsage = Number.isFinite(usage) ? formatBytes(usage) : "unknown";
    const browserQuota = Number.isFinite(quota) ? formatBytes(quota) : "unknown";
    libraryStorage.textContent = `${records.length} ${records.length === 1 ? "file" : "files"} · ${formatBytes(libraryBytes)} in your library · ${browserUsage} of ${browserQuota} browser storage used`;
  } catch {
    libraryStorage.textContent = `${records.length} ${records.length === 1 ? "file" : "files"} · ${formatBytes(libraryBytes)} in your library`;
  }
}

function createMediaAction(label, className, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `media-action ${className}`;
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

async function startPlayback(record) {
  try {
    const blob = await getMediaBlob(record.id);
    if (!blob) throw new Error("The media file is missing from local storage.");

    audioPlayer.pause();
    videoPlayer.pause();
    audioPlayer.removeAttribute("src");
    videoPlayer.removeAttribute("src");
    audioPlayer.load();
    videoPlayer.load();
    if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);

    const playableBlob = blob.type === record.type
      ? blob
      : blob.slice(0, blob.size, record.type);
    activeObjectUrl = URL.createObjectURL(playableBlob);
    activeMediaId = record.id;
    currentMediaTitle.textContent = record.name;
    mediaPlayer.hidden = false;

    const player = record.kind === "video" ? videoPlayer : audioPlayer;
    const otherPlayer = player === videoPlayer ? audioPlayer : videoPlayer;
    otherPlayer.hidden = true;
    player.hidden = false;
    player.src = activeObjectUrl;

    try {
      await player.play();
      setLibraryStatus(`Playing ${record.name}`);
    } catch {
      setLibraryStatus(`Ready to play ${record.name}. Press play in the player controls.`);
    }
  } catch (error) {
    setLibraryStatus(`Could not open this file: ${error.message}`);
  }
}

function stopPlayback() {
  audioPlayer.pause();
  videoPlayer.pause();
  audioPlayer.removeAttribute("src");
  videoPlayer.removeAttribute("src");
  audioPlayer.load();
  videoPlayer.load();
  if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
  activeObjectUrl = null;
  activeMediaId = null;
  mediaPlayer.hidden = true;
}

async function removeMedia(record) {
  if (!window.confirm(`Delete “${record.name}” from Puffin on this device?`)) return;

  try {
    await deleteMediaFile(record.id);
    if (activeMediaId === record.id) stopPlayback();
    await renderLibrary();
    setLibraryStatus(`Deleted ${record.name} from this device.`);
  } catch (error) {
    setLibraryStatus(`Could not delete this file: ${error.message}`);
  }
}

async function renderLibrary() {
  try {
    const records = await listMediaFiles();
    mediaList.replaceChildren();

    if (records.length === 0) {
      const emptyMessage = document.createElement("li");
      emptyMessage.className = "empty-library";
      emptyMessage.textContent = "No media yet. Import audio or video files to get started.";
      mediaList.append(emptyMessage);
    } else {
      records.forEach((record) => {
        const item = document.createElement("li");
        item.className = "media-item";

        const info = document.createElement("div");
        info.className = "media-info";

        const name = document.createElement("span");
        name.className = "media-name";
        name.textContent = record.name;

        const details = document.createElement("span");
        details.className = "media-details";
        const kind = record.kind === "video" ? "Video" : "Audio";
        details.textContent = `${kind} · ${formatBytes(record.size)} · Added ${new Date(record.importedAt).toLocaleDateString()}`;

        info.append(name, details);

        const actions = document.createElement("div");
        actions.className = "media-actions";
        actions.append(
          createMediaAction("Play", "secondary", () => startPlayback(record)),
          createMediaAction("Delete", "danger", () => removeMedia(record)),
        );

        item.append(info, actions);
        mediaList.append(item);
      });
    }

    await updateStorageSummary(records);
    return records;
  } catch (error) {
    setLibraryStatus(`Could not open the local library: ${error.message}`);
    libraryStorage.textContent = "Browser storage information is unavailable.";
    return null;
  }
}

importButton.addEventListener("click", () => filePicker.click());
filePicker.addEventListener("change", async () => {
  const files = Array.from(filePicker.files || []);
  filePicker.value = "";
  if (files.length === 0) return;

  importButton.disabled = true;
  let imported = 0;
  let skipped = 0;
  let failure;

  try {
    try {
      if (navigator.storage?.persist) await navigator.storage.persist();
    } catch {
      // Importing can still proceed when persistent storage cannot be requested.
    }

    for (const file of files) {
      if (!getMediaKind(file.name, file.type)) {
        skipped += 1;
        continue;
      }

      setLibraryStatus(`Importing ${file.name}…`);
      try {
        await saveMediaFile(file);
        imported += 1;
      } catch (error) {
        failure = error;
        break;
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    importButton.disabled = false;
  }

  const records = await renderLibrary();
  if (failure) {
    const reason = failure.name === "QuotaExceededError"
      ? "There is not enough browser storage. Delete some files and try again."
      : failure.message;
    setLibraryStatus(`Import stopped after ${imported} file(s): ${reason}`);
  } else if (imported || skipped) {
    const skippedMessage = skipped ? ` ${skipped} unsupported file(s) skipped.` : "";
    setLibraryStatus(`Imported ${imported} file(s).${skippedMessage}`);
  } else {
    const count = records?.length ?? 0;
    setLibraryStatus(`${count} ${count === 1 ? "file" : "files"} in your library.`);
  }
});

for (const player of [audioPlayer, videoPlayer]) {
  player.addEventListener("error", () => {
    setLibraryStatus("This browser could not play the selected file or format.");
  });
}

renderLibrary().then((records) => {
  if (!records) return;
  if (records.length === 0) setLibraryStatus("Your library is empty. Import audio or video files to get started.");
  else setLibraryStatus(`${records.length} ${records.length === 1 ? "file" : "files"} in your library.`);
});

window.addEventListener("puffin:library-updated", async () => {
  const records = await renderLibrary();
  if (records) {
    setLibraryStatus(`${records.length} ${records.length === 1 ? "file" : "files"} in your library.`);
  }
});

initializeDownloader();

if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.error("Puffin could not register its offline app worker:", error);
    });
  });
}
