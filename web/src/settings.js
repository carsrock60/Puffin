import {
  getMediaStorageCapacity,
  getMediaStorageLimit,
  listMediaFiles,
  setMediaStorageLimit,
  clearRecentlyPlayed,
} from "./library.js";
import { formatBytes, getMediaCapacityState } from "./media-capacity.js";
import { getHomePreferences, saveHomePreferences } from "./home-preferences.js";
import { getDownloadPreferences, saveDownloadPreferences } from "./download-preferences.js";

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
  const showPicks = document.querySelector("#settings-show-picks");
  const musicAtlasForm = document.querySelector("#settings-musicatlas-form");
  const musicAtlasKey = document.querySelector("#settings-musicatlas-key");
  const homeStatus = document.querySelector("#settings-home-status");
  const acoustidForm = document.querySelector("#settings-acoustid-form");
  const acoustidKey = document.querySelector("#settings-acoustid-key");
  const acoustidStatus = document.querySelector("#settings-acoustid-status");
  const clearHistoryButton = document.querySelector("#settings-clear-history");
  const piOptions = document.querySelector("#settings-pi-options");
  const piAddress = document.querySelector("#settings-pi-address");
  const checkPiButton = document.querySelector("#settings-check-pi");
  const downloadStatus = document.querySelector("#settings-download-status");
  let currentLibraryBytes = 0;

  const homePreferences = getHomePreferences();
  showRecent.checked = homePreferences.showRecentlyPlayed;
  showPicks.checked = homePreferences.showMusicPicks;
  musicAtlasKey.value = homePreferences.musicAtlasApiKey;
  acoustidKey.value = homePreferences.acoustidClientKey;
  const downloadPreferences = getDownloadPreferences();
  piAddress.value = downloadPreferences.piAddress;
  piOptions.hidden = false;

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
        showMusicPicks: showPicks.checked,
        musicAtlasApiKey: musicAtlasKey.value,
        acoustidClientKey: acoustidKey.value,
      });
      homeStatus.textContent = "Home preferences saved on this device.";
    } catch (error) {
      homeStatus.textContent = error.message;
    }
  }
  showRecent.addEventListener("change", persistHomeVisibility);
  showPicks.addEventListener("change", persistHomeVisibility);
  musicAtlasForm.addEventListener("submit", (event) => {
    event.preventDefault();
    persistHomeVisibility();
  });
  acoustidForm.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      saveHomePreferences({
        showRecentlyPlayed: showRecent.checked,
        showMusicPicks: showPicks.checked,
        musicAtlasApiKey: musicAtlasKey.value,
        acoustidClientKey: acoustidKey.value,
      });
      acoustidStatus.textContent = "AcoustID key saved on this device.";
    } catch (error) {
      acoustidStatus.textContent = error.message;
    }
  });
  function persistDownloadPreferences() {
    try {
      saveDownloadPreferences({ piAddress: piAddress.value });
      downloadStatus.textContent = "Download settings saved on this device.";
    } catch {
      downloadStatus.textContent = "Puffin could not save download settings on this device.";
    }
  }
  piAddress.addEventListener("change", persistDownloadPreferences);
  checkPiButton.addEventListener("click", async () => {
    checkPiButton.disabled = true;
    try {
      const parsed = new URL(piAddress.value.trim());
      if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
        throw new Error("Enter the Pi's HTTPS Tailscale Serve address.");
      }
      const response = await fetch(`${parsed.origin}/api/health`);
      if (!response.ok) throw new Error(`Pi returned ${response.status}.`);
      const health = await response.json();
      if (!health.ok) throw new Error("The Pi service did not return a healthy status.");
      saveDownloadPreferences({ piAddress: piAddress.value });
      downloadStatus.textContent = "Pi is connected and ready.";
    } catch (error) {
      downloadStatus.textContent = error.message === "Failed to fetch"
        ? "Could not reach the Pi. Check Tailscale, its HTTPS address, and allowed origins."
        : error.message || "Could not reach the Pi.";
    } finally {
      checkPiButton.disabled = false;
    }
  });
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
