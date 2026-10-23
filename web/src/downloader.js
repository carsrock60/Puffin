import { assertMediaStorageCapacity, getMediaStorageCapacity, saveMediaFile } from "./library.js";
import { guardReadyPiDownload, MediaCapacityError } from "./media-capacity.js";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function getPiBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("Enter the Pi's HTTPS address from Tailscale Serve.");
  }

  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error("Use the Pi's HTTPS Tailscale address, for example https://pi-name.tailnet.ts.net.");
  }

  return parsed.origin;
}

async function responsePayload(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function requestJson(baseUrl, endpoint, options) {
  const response = await fetch(`${baseUrl}${endpoint}`, options);
  const payload = await responsePayload(response);
  if (!response.ok) throw new Error(payload.error || `Pi request failed (${response.status}).`);
  return payload;
}

function setStatus(element, message) {
  element.textContent = message;
}

async function checkPi(baseUrl) {
  const health = await requestJson(baseUrl, "/api/health");
  if (!health.ok) throw new Error("The Pi service did not return a healthy status.");
}

async function confirmPiSavedFile(baseUrl, jobId) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/downloads/${jobId}/complete`, { method: "POST" });
    if (response.ok) return true;

    const payload = await responsePayload(response);
    if (response.status !== 409) {
      throw new Error(payload.error || `Pi cleanup confirmation failed (${response.status}).`);
    }
    await sleep(250);
  }
  return false;
}

async function cancelPiDownload(baseUrl, jobId) {
  const response = await fetch(`${baseUrl}/api/downloads/${jobId}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Pi cleanup failed (${response.status}).`);
  }
}

export function initializeDownloader() {
  const form = document.querySelector("#download-form");
  const piAddress = document.querySelector("#pi-address");
  const youtubeUrl = document.querySelector("#youtube-url");
  const youtubeLinkField = document.querySelector("#youtube-link-field");
  const downloadSourceLink = document.querySelector("#download-source-link");
  const downloadSourceBrowse = document.querySelector("#download-source-browse");
  const youtubeBrowsePanel = document.querySelector("#youtube-browse-panel");
  const youtubeSearchQuery = document.querySelector("#youtube-search-query");
  const youtubeSearchButton = document.querySelector("#youtube-search-button");
  const youtubeSearchStatus = document.querySelector("#youtube-search-status");
  const youtubeSearchResults = document.querySelector("#youtube-search-results");
  const youtubeSelectedVideo = document.querySelector("#youtube-selected-video");
  const youtubeSelectedTitle = document.querySelector("#youtube-selected-title");
  const youtubeClearSelection = document.querySelector("#youtube-clear-selection");
  const downloadKind = document.querySelector("#download-kind");
  const checkButton = document.querySelector("#check-pi");
  const submitButton = document.querySelector("#start-download");
  const progress = document.querySelector("#download-progress");
  const status = document.querySelector("#download-status");
  let downloadSource = "link";

  function setDownloadSource(source) {
    downloadSource = source;
    const browsing = source === "browse";
    youtubeLinkField.hidden = browsing;
    youtubeBrowsePanel.hidden = !browsing;
    youtubeUrl.required = !browsing;
    downloadSourceLink.classList.toggle("is-selected", !browsing);
    downloadSourceBrowse.classList.toggle("is-selected", browsing);
    downloadSourceLink.setAttribute("aria-pressed", String(!browsing));
    downloadSourceBrowse.setAttribute("aria-pressed", String(browsing));
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(Number(seconds)) || Number(seconds) < 0) return "Duration unavailable";
    const total = Math.floor(Number(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainder = total % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
      : `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function renderYouTubeResults(videos) {
    youtubeSearchResults.replaceChildren();
    if (!videos.length) {
      youtubeSearchStatus.textContent = "No videos found. Try a different search.";
      return;
    }

    youtubeSearchStatus.textContent = `${videos.length} ${videos.length === 1 ? "video" : "videos"} found.`;
    videos.forEach((video) => {
      const item = document.createElement("li");
      item.className = "youtube-result";

      const thumbnail = document.createElement("img");
      thumbnail.className = "youtube-result-thumbnail";
      thumbnail.alt = "";
      thumbnail.loading = "lazy";
      thumbnail.referrerPolicy = "no-referrer";
      if (video.thumbnail) {
        try {
          const thumbnailUrl = new URL(video.thumbnail);
          if (thumbnailUrl.protocol === "https:") thumbnail.src = thumbnailUrl.href;
          else thumbnail.hidden = true;
        } catch {
          thumbnail.hidden = true;
        }
      } else thumbnail.hidden = true;
      thumbnail.addEventListener("error", () => { thumbnail.hidden = true; });

      const details = document.createElement("div");
      details.className = "youtube-result-details";
      const title = document.createElement("strong");
      title.textContent = video.title || "Untitled video";
      const metadata = document.createElement("span");
      metadata.textContent = `${video.channel || "Unknown channel"} · ${formatDuration(video.duration)}`;
      details.append(title, metadata);

      const actions = document.createElement("div");
      actions.className = "youtube-result-actions";
      const preview = document.createElement("button");
      preview.className = "secondary-button youtube-result-preview";
      preview.type = "button";
      preview.textContent = "Preview";
      preview.addEventListener("click", () => window.open(video.url, "_blank", "noopener,noreferrer"));

      const choose = document.createElement("button");
      choose.className = "secondary-button youtube-result-choose";
      choose.type = "button";
      choose.textContent = "Download this";
      choose.addEventListener("click", () => {
        youtubeUrl.value = video.url;
        youtubeSelectedTitle.textContent = video.title || "Selected video";
        youtubeSelectedVideo.hidden = false;
        youtubeSearchStatus.textContent = "Video selected. Choose a format and start the download.";
      });

      actions.append(preview, choose);
      item.append(thumbnail, details, actions);
      youtubeSearchResults.append(item);
    });
  }

  async function searchYouTube() {
    const query = youtubeSearchQuery.value.trim();
    if (!query) {
      youtubeSearchStatus.textContent = "Enter a search term first.";
      youtubeSearchQuery.focus();
      return;
    }

    youtubeSearchButton.disabled = true;
    youtubeSearchStatus.textContent = "Searching YouTube…";
    youtubeSearchResults.replaceChildren();
    try {
      const baseUrl = getPiBaseUrl(piAddress.value);
      const result = await requestJson(baseUrl, `/api/search?q=${encodeURIComponent(query)}`);
      renderYouTubeResults(Array.isArray(result.videos) ? result.videos : []);
    } catch (error) {
      youtubeSearchStatus.textContent = error.message || "YouTube search failed.";
    } finally {
      youtubeSearchButton.disabled = false;
    }
  }

  downloadSourceLink.addEventListener("click", () => setDownloadSource("link"));
  downloadSourceBrowse.addEventListener("click", () => setDownloadSource("browse"));
  youtubeSearchButton.addEventListener("click", searchYouTube);
  youtubeSearchQuery.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      searchYouTube();
    }
  });
  youtubeClearSelection.addEventListener("click", () => {
    youtubeUrl.value = "";
    youtubeSelectedVideo.hidden = true;
    youtubeSearchStatus.textContent = "Choose a video from the results before downloading.";
  });
  youtubeUrl.addEventListener("input", () => {
    if (downloadSource === "link") youtubeSelectedVideo.hidden = true;
  });

  try {
    piAddress.value = localStorage.getItem("puffin-pi-address") || "";
  } catch {
    // The address can still be entered and used if local storage is unavailable.
  }

  piAddress.addEventListener("change", () => {
    try {
      localStorage.setItem("puffin-pi-address", piAddress.value.trim());
    } catch {
      // Saving the address is optional; it can be re-entered next time.
    }
  });

  checkButton.addEventListener("click", async () => {
    checkButton.disabled = true;
    try {
      const baseUrl = getPiBaseUrl(piAddress.value);
      setStatus(status, "Checking Pi connection…");
      await checkPi(baseUrl);
      setStatus(status, "Pi is connected and ready.");
    } catch (error) {
      setStatus(status, error.message);
    } finally {
      checkButton.disabled = false;
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const hasSelectedBrowseResult = downloadSource !== "browse" || !youtubeSelectedVideo.hidden;
    if (!youtubeUrl.value.trim() || !hasSelectedBrowseResult) {
      setStatus(status, downloadSource === "browse"
        ? "Search YouTube and choose a video before downloading."
        : "Enter a YouTube link before downloading.");
      return;
    }
    submitButton.disabled = true;
    checkButton.disabled = true;
    progress.hidden = false;
    progress.value = 0;

    let baseUrl;
    let jobId;
    let savedLocally = false;
    let transferStarted = false;

    try {
      baseUrl = getPiBaseUrl(piAddress.value);
      const capacity = await getMediaStorageCapacity();
      if (capacity.remainingBytes <= 0) {
        throw new Error("Puffin media storage limit reached. Delete files or raise the limit before downloading.");
      }
      try {
        localStorage.setItem("puffin-pi-address", baseUrl);
      } catch {
        // Saving the address is optional; the current download can proceed.
      }
      setStatus(status, "Connecting to the Pi…");
      await checkPi(baseUrl);

      const job = await requestJson(baseUrl, "/api/downloads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: youtubeUrl.value.trim(), kind: downloadKind.value }),
      });
      jobId = job.id;

      let currentJob = job;
      while (["queued", "downloading", "converting"].includes(currentJob.status)) {
        progress.value = currentJob.progress || 0;
        if (currentJob.status === "queued") setStatus(status, "Pi download queued…");
        else if (currentJob.status === "converting") setStatus(status, "Converting media on the Pi…");
        else if (currentJob.progress) setStatus(status, `Downloading on the Pi · ${Math.round(currentJob.progress)}%`);
        else setStatus(status, "Downloading on the Pi…");

        await sleep(1200);
        currentJob = await requestJson(baseUrl, `/api/downloads/${jobId}`);
      }

      if (currentJob.status !== "ready") {
        throw new Error(currentJob.error || "The Pi download did not finish.");
      }

      try {
        await guardReadyPiDownload({
          fileSize: currentJob.size,
          assertCapacity: assertMediaStorageCapacity,
          cancelDownload: () => cancelPiDownload(baseUrl, jobId),
        });
      } catch (error) {
        jobId = null;
        throw error;
      }

      progress.value = 100;
      setStatus(status, "Receiving file from the Pi…");
      transferStarted = true;
      const fileResponse = await fetch(`${baseUrl}/api/downloads/${jobId}/file`);
      if (!fileResponse.ok) {
        const payload = await responsePayload(fileResponse);
        throw new Error(payload.error || `File transfer failed (${fileResponse.status}).`);
      }

      const mediaBlob = await fileResponse.blob();
      setStatus(status, "Saving to this device…");
      const encodedName = fileResponse.headers.get("X-Download-Name");
      let filename = `puffin-download.${downloadKind.value === "audio" ? "m4a" : "mp4"}`;
      if (encodedName) {
        try {
          filename = decodeURIComponent(encodedName);
        } catch {
          filename = encodedName;
        }
      } else if (currentJob.filename) {
        filename = currentJob.filename;
      }

      try {
        if (navigator.storage?.persist) await navigator.storage.persist();
      } catch {
        // IndexedDB can still save the file when persistent storage is unavailable.
      }
      await saveMediaFile(mediaBlob, { name: filename, type: currentJob.mime_type || mediaBlob.type });
      savedLocally = true;
      window.dispatchEvent(new Event("puffin:library-updated"));

      try {
        const cleanedUp = await confirmPiSavedFile(baseUrl, jobId);
        if (cleanedUp) setStatus(status, "Saved to your Puffin library on this device.");
        else setStatus(status, "Saved locally. The Pi will remove its temporary copy after it expires.");
      } catch {
        setStatus(status, "Saved locally. The Pi could not confirm cleanup; its temporary copy will expire automatically.");
      }
    } catch (error) {
      setStatus(status, error.message || "The download failed.");
      if (jobId && baseUrl && !savedLocally) {
        if (transferStarted && error instanceof MediaCapacityError) {
          try {
            await cancelPiDownload(baseUrl, jobId);
          } catch {
            setStatus(status, `${error.message} The Pi could not confirm cleanup; its temporary copy will expire automatically.`);
          }
        } else if (transferStarted) {
          // Keep completed files on the Pi for retry if transfer or browser storage fails.
          setStatus(status, `${error.message || "The transfer failed."} The Pi will keep its temporary copy for up to one hour.`);
        } else {
          fetch(`${baseUrl}/api/downloads/${jobId}`, { method: "DELETE" }).catch(() => {});
        }
      }
    } finally {
      submitButton.disabled = false;
      checkButton.disabled = false;
      progress.hidden = true;
    }
  });
}
