import {
  getMediaStorageCapacity,
  getMediaStorageLimit,
  listMediaFiles,
  setMediaStorageLimit,
  clearRecentlyPlayed,
} from "./library.js";
import { formatBytes, getMediaCapacityState } from "./media-capacity.js";
import { getHomePreferences, saveHomePreferences } from "./home-preferences.js";

export function initializeSettings() {
  const dialog = document.querySelector("#settings-dialog");
  const openButtons = document.querySelectorAll("[data-open-settings]");
  const backButton = document.querySelector("#settings-back");
  const closeButton = document.querySelector("#settings-close");
  const sectionButtons = dialog.querySelectorAll("[data-settings-section]");
  const sections = dialog.querySelectorAll("[data-settings-panel]");
  const storageForm = document.querySelector("#settings-storage-form");
  const mediaLimitInput = document.querySelector("#settings-media-limit");
  const libraryStorage = document.querySelector("#library-storage");
  const capacityMeter = document.querySelector("#settings-capacity-meter");
  const capacityLabel = document.querySelector("#settings-capacity-label");
  const capacityProgress = document.querySelector("#settings-capacity-progress");
  const capacityWarning = document.querySelector("#settings-capacity-warning");
  const storageStatus = document.querySelector("#settings-storage-status");
  const showRecent = document.querySelector("#settings-show-recent");
  const homeStatus = document.querySelector("#settings-home-status");
  const acoustidForm = document.querySelector("#settings-acoustid-form");
  const acoustidKey = document.querySelector("#settings-acoustid-key");
  const acoustidRemove = document.querySelector("#settings-acoustid-remove");
  const acoustidStatus = document.querySelector("#settings-acoustid-status");
  const clearHistoryButton = document.querySelector("#settings-clear-history");
  const downloadEngine = document.querySelector("#settings-download-engine");
  const clearDownloadCache = document.querySelector("#settings-clear-download-cache");
  const downloadStatus = document.querySelector("#settings-download-status");
  const desktopDownloadPanel = document.querySelector("#settings-download-desktop");
  const webDownloadPanel = document.querySelector("#settings-download-web");
  const desktopDownloads = window.puffinDesktop?.downloads;
  let currentLibraryBytes = 0;

  const homePreferences = getHomePreferences();
  showRecent.checked = homePreferences.showRecentlyPlayed;
  acoustidKey.value = homePreferences.acoustidClientKey;

  mediaLimitInput.value = (getMediaStorageLimit() / 1024 ** 3).toFixed(1);

  function selectSection(sectionName) {
    sectionButtons.forEach((button) => {
      if (button.dataset.settingsSection === sectionName) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    sections.forEach((section) => {
      section.hidden = section.dataset.settingsPanel !== sectionName;
    });
  }

  async function refreshStorageDetails() {
    try {
      const [records, capacity, estimate] = await Promise.all([
        listMediaFiles(),
        getMediaStorageCapacity(),
        navigator.storage?.estimate ? navigator.storage.estimate() : Promise.resolve(null),
      ]);
      currentLibraryBytes = records.reduce((total, record) => total + record.size, 0);
      let browserEstimate = "browser storage information unavailable";
      if (estimate && Number.isFinite(estimate.usage) && Number.isFinite(estimate.quota)) {
        browserEstimate = `${formatBytes(estimate.usage)} of ${formatBytes(estimate.quota)} browser storage used`;
      }
      libraryStorage.textContent = `${records.length} ${records.length === 1 ? "file" : "files"} · ${formatBytes(currentLibraryBytes)} in your library · ${browserEstimate}`;
      mediaLimitInput.value = (getMediaStorageLimit() / 1024 ** 3).toFixed(1);
      currentLibraryBytes = capacity.usedBytes;
      updateCapacityDisplay(capacity.limitBytes);
    } catch {
      libraryStorage.textContent = "Library and browser storage information unavailable.";
      capacityLabel.textContent = "Unavailable";
    }
  }

  function updateCapacityDisplay(limitBytes) {
    const capacity = getMediaCapacityState(currentLibraryBytes, limitBytes);
    const percent = Math.min(100, capacity.usagePercent);
    capacityProgress.value = Number.isFinite(percent) ? percent : 100;
    capacityMeter.classList.toggle("is-over-limit", capacity.isOverLimit);

    if (capacity.isOverLimit) {
      capacityLabel.textContent = `${formatBytes(capacity.usedBytes)} used of ${formatBytes(capacity.limitBytes)} · ${formatBytes(capacity.usedBytes - capacity.limitBytes)} over`;
      capacityWarning.textContent = `Your existing library is ${formatBytes(capacity.usedBytes - capacity.limitBytes)} over this limit. Puffin keeps existing files, but blocks new imports and downloads until you free space or raise the limit.`;
      capacityWarning.hidden = false;
    } else if (capacity.isAtLimit) {
      capacityLabel.textContent = `${formatBytes(capacity.usedBytes)} of ${formatBytes(capacity.limitBytes)} · limit reached`;
      capacityWarning.textContent = "Your media limit is reached. Delete files or raise the limit before importing or downloading more media.";
      capacityWarning.hidden = false;
    } else {
      capacityLabel.textContent = `${formatBytes(capacity.usedBytes)} of ${formatBytes(capacity.limitBytes)}`;
      capacityWarning.hidden = true;
    }
  }

  const openSettings = () => {
    selectSection("files");
    storageStatus.textContent = "";
    dialog.showModal();
    refreshStorageDetails();
    backButton.focus();
  };
  openButtons.forEach((button) => button.addEventListener("click", openSettings));

  sectionButtons.forEach((button) => {
    button.addEventListener("click", () => selectSection(button.dataset.settingsSection));
  });

  function persistHomeVisibility() {
    try {
      saveHomePreferences({
        showRecentlyPlayed: showRecent.checked,
        acoustidClientKey: acoustidKey.value,
      });
      homeStatus.textContent = "Home preferences saved on this device.";
    } catch (error) {
      homeStatus.textContent = error.message;
    }
  }
  showRecent.addEventListener("change", persistHomeVisibility);
  acoustidForm.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      saveHomePreferences({
        showRecentlyPlayed: showRecent.checked,
        acoustidClientKey: acoustidKey.value,
      });
      acoustidStatus.textContent = "AcoustID key saved on this device.";
    } catch (error) {
      acoustidStatus.textContent = error.message;
    }
  });
  acoustidRemove.addEventListener("click", () => {
    acoustidKey.value = "";
    persistHomeVisibility();
    acoustidStatus.textContent = "AcoustID key removed from this browser.";
  });
  if (desktopDownloads) {
    if (webDownloadPanel) webDownloadPanel.hidden = true;
    if (desktopDownloadPanel) desktopDownloadPanel.hidden = false;
    desktopDownloads.getInfo()
      .then((info) => {
        if (!downloadEngine) return;
        const parts = [info?.engine || "yt-dlp", info?.ffmpeg ? "FFmpeg" : ""].filter(Boolean);
        downloadEngine.textContent = `${parts.join(" · ")} running locally on this device.`;
      })
      .catch(() => {
        if (downloadEngine) downloadEngine.textContent = "The on-device downloader is not ready yet. It starts on the first download.";
      });
    clearDownloadCache?.addEventListener("click", async () => {
      clearDownloadCache.disabled = true;
      try {
        const result = await desktopDownloads.clearTemp();
        downloadStatus.textContent = result?.removed
          ? `Cleared ${result.removed} temporary ${result.removed === 1 ? "folder" : "folders"}.`
          : "There are no temporary download files to clear.";
      } catch (error) {
        downloadStatus.textContent = error?.message || "Puffin could not clear temporary download files.";
      } finally {
        clearDownloadCache.disabled = false;
      }
    });
  } else {
    if (desktopDownloadPanel) desktopDownloadPanel.hidden = true;
    if (webDownloadPanel) webDownloadPanel.hidden = false;
  }
  clearHistoryButton.addEventListener("click", async () => {
    if (!window.confirm("Clear all recently played history on this device?")) return;
    clearHistoryButton.disabled = true;
    try {
      await clearRecentlyPlayed();
      homeStatus.textContent = "Recently played history cleared.";
    } catch (error) {
      homeStatus.textContent = error.message || "Could not clear recently played history.";
    } finally {
      clearHistoryButton.disabled = false;
    }
  });
  backButton.addEventListener("click", () => dialog.close());
  closeButton.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });

  storageForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const gigabytes = Number(mediaLimitInput.value);
    try {
      if (!Number.isFinite(gigabytes) || gigabytes < 0.1 || gigabytes > 1000) {
        throw new Error("Choose a limit between 0.1 and 1000 GB.");
      }
      setMediaStorageLimit(gigabytes * 1024 ** 3);
      updateCapacityDisplay(gigabytes * 1024 ** 3);
      storageStatus.textContent = currentLibraryBytes > gigabytes * 1024 ** 3
        ? `Saved ${gigabytes.toFixed(1)} GB. Your existing library exceeds this limit; Puffin will block new media until there is room.`
        : `Media limit saved at ${gigabytes.toFixed(1)} GB.`;
    } catch (error) {
      storageStatus.textContent = error.message || "Could not save the media limit.";
    }
  });

  mediaLimitInput.addEventListener("input", () => {
    const gigabytes = Number(mediaLimitInput.value);
    if (Number.isFinite(gigabytes) && gigabytes > 0) updateCapacityDisplay(gigabytes * 1024 ** 3);
  });

  window.addEventListener("puffin:library-updated", refreshStorageDetails);
  window.addEventListener("puffin:storage-updated", refreshStorageDetails);
}
