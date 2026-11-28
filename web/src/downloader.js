import { assertMediaStorageCapacity, getMediaStorageCapacity, recordPuffinActivity, saveMediaFile } from "./library.js";
import { describeDownloadStage } from "./download-stage.js";
import { formatBytes, guardReadyDownload, MediaCapacityError } from "./media-capacity.js";
import { videoHeightForSliderValue, videoHeightLabel, videoQualityLabel } from "./video-quality.js";
import { animateElement, MOTION_EASE } from "./motion.js";

function setStatus(element, message) {
  element.textContent = message;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const rounded = Math.ceil(seconds);
  const minutes = Math.floor(rounded / 60);
  return minutes ? `${minutes}:${String(rounded % 60).padStart(2, "0")}` : `${rounded}s`;
}

function filenameFromResponse(response, sourceUrl, mimeType) {
  const disposition = response.headers.get("Content-Disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  let name = "";
  try { name = encoded ? decodeURIComponent(encoded) : (plain || ""); } catch { name = plain || ""; }
  if (!name) {
    try { name = decodeURIComponent(new URL(sourceUrl).pathname.split("/").pop() || ""); } catch { name = ""; }
  }
  if (!/\.[a-z0-9]{2,5}$/i.test(name) && (mimeType.startsWith("audio/") || mimeType.startsWith("video/"))) {
    const extensions = {
      "audio/aac": "aac", "audio/flac": "flac", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mp4": "m4a",
      "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/ogg": "ogv",
    };
    const extension = extensions[mimeType] || (mimeType.startsWith("audio/") ? "m4a" : "mp4");
    name = `${name || "puffin-download"}.${extension}`;
  }
  return (name || "puffin-download").replace(/[\\/:*?"<>|\r\n]/g, "_").slice(0, 180);
}

function removeLastBracketedPart(filename) {
  const extensionMatch = filename.match(/(\.[a-z0-9]{2,5})$/i);
  const extension = extensionMatch?.[1] || "";
  const name = extension ? filename.slice(0, -extension.length) : filename;
  const open = name.lastIndexOf("[");
  const close = name.lastIndexOf("]");
  if (open < 0 || close <= open) return filename;

  const cleaned = `${name.slice(0, open)}${name.slice(close + 1)}`.replace(/\s+/g, " ").trim();
  return `${cleaned || "Puffin download"}${extension}`;
}

async function readDirectMedia(response, sourceUrl, capacity, onProgress) {
  const mimeType = (response.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  const name = filenameFromResponse(response, sourceUrl, mimeType);
  if (!mimeType.startsWith("audio/") && !mimeType.startsWith("video/") && !/\.(m4a|mp3|aac|wav|flac|ogg|opus|mp4|m4v|mov|webm|ogv)$/i.test(name)) {
    await response.body?.cancel();
    throw new Error("Puffin could not read the downloaded media file.");
  }
  if (!response.body?.getReader) throw new Error("Puffin cannot stream this response on this device.");
  const total = Number(response.headers.get("Content-Length")) || 0;
  if (total && total > capacity.remainingBytes) {
    await response.body.cancel();
    await assertMediaStorageCapacity(total);
  }
  const reader = response.body.getReader();
  const chunks = [];
  const started = Date.now();
  let received = 0;
  let lastReceived = 0;
  let lastTime = started;
  let nextCapacityCheck = 1024 * 1024;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > capacity.remainingBytes) {
        await reader.cancel();
        await assertMediaStorageCapacity(received);
      }
      if (received >= nextCapacityCheck) {
        await assertMediaStorageCapacity(received);
        nextCapacityCheck = received + 1024 * 1024;
      }
      chunks.push(value);
      const now = Date.now();
      const speed = (received - lastReceived) / Math.max(0.001, (now - lastTime) / 1000);
      const averageSpeed = received / Math.max(0.001, (now - started) / 1000);
      onProgress({ received, total, speed, eta: total ? (total - received) / Math.max(averageSpeed, 1) : null });
      lastReceived = received;
      lastTime = now;
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* stream already closed */ }
    throw error;
  }
  if (total && received !== total) throw new Error("The connection ended before the full file arrived. Try again.");
  await assertMediaStorageCapacity(received);
  return { blob: new Blob(chunks, { type: mimeType || "application/octet-stream" }), name, mimeType };
}

async function videoFrameArtwork(blob) {
  const video = document.createElement("video");
  const url = URL.createObjectURL(blob);
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  try {
    video.src = url;
    await new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("Video thumbnail timed out")), 8000);
      video.addEventListener("loadedmetadata", () => {
        video.currentTime = Math.min(1, Math.max(0, video.duration / 2));
      }, { once: true });
      video.addEventListener("seeked", () => { clearTimeout(timeout); resolve(); }, { once: true });
      video.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Video thumbnail unavailable")); }, { once: true });
    });
    const scale = Math.min(1, 480 / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.78);
  } catch {
    return "";
  } finally {
    video.pause();
    video.removeAttribute("src");
    URL.revokeObjectURL(url);
  }
}

function waitForJob(desktopDownloads, jobId, { signal, onStage }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const handler = (payload) => {
      if (!payload || payload.jobId !== jobId) return;
      onStage(payload);
      if (payload.status === "ready") finish(resolve, payload);
      else if (payload.status === "failed") finish(reject, new Error(payload.error || "The on-device download failed."));
      else if (payload.status === "cancelled") finish(reject, new DOMException("Download cancelled.", "AbortError"));
    };
    const onAbort = () => finish(reject, new DOMException("Download cancelled.", "AbortError"));
    const unsubscribe = desktopDownloads.onProgress(handler);
    signal?.addEventListener("abort", onAbort, { once: true });
    desktopDownloads.getStatus(jobId).then((payload) => {
      if (payload) handler(payload);
    }).catch(() => { /* Live progress events will report the result. */ });
  });
}

export function initializeDownloader() {
  const form = document.querySelector("#download-form");
  if (!form) return;
  const desktopRequired = document.querySelector("#download-desktop-required");
  const desktopDownloads = window.puffinDesktop?.downloads;
  if (!desktopDownloads) {
    form.hidden = true;
    if (desktopRequired) desktopRequired.hidden = false;
    return;
  }
  form.hidden = false;
  if (desktopRequired) desktopRequired.hidden = true;

  const youtubeUrl = document.querySelector("#youtube-url");
  const youtubeLinkField = document.querySelector("#youtube-link-field");
  const downloadLinkRow = document.querySelector("#download-link-row");
  const downloadSourceLink = document.querySelector("#download-source-link");
  const downloadSourceBrowse = document.querySelector("#download-source-browse");
  const downloadFormatField = document.querySelector("#download-format-field");
  const youtubeBrowsePanel = document.querySelector("#youtube-browse-panel");
  const youtubeSearchRow = youtubeBrowsePanel.querySelector(".youtube-search-row");
  const youtubeSearchQuery = document.querySelector("#youtube-search-query");
  const youtubeSearchButton = document.querySelector("#youtube-search-button");
  const youtubeSearchStatus = document.querySelector("#youtube-search-status");
  const youtubeSearchResults = document.querySelector("#youtube-search-results");
  const youtubeSelectedVideo = document.querySelector("#youtube-selected-video");
  const youtubeSelectedTitle = document.querySelector("#youtube-selected-title");
  const youtubeClearSelection = document.querySelector("#youtube-clear-selection");
  const downloadKind = document.querySelector("#download-kind");
  const videoQualityField = document.querySelector("#video-quality-field");
  const videoQuality = document.querySelector("#video-quality");
  const videoQualityValue = document.querySelector("#video-quality-value");
  function updateVideoQuality() {
    const index = Number(videoQuality.value);
    videoQualityValue.value = videoQualityLabel(index);
    videoQuality.style.setProperty("--quality-color", `hsl(${120 - index * 20} 70% 42%)`);
    videoQuality.style.setProperty("--quality-progress", `${index / 6 * 100}%`);
  }
  videoQuality.addEventListener("input", updateVideoQuality);
  updateVideoQuality();
  const submitButton = document.querySelector("#start-download");
  const cancelButton = document.querySelector("#cancel-download");
  const progress = document.querySelector("#download-progress");
  const progressDetails = document.querySelector("#download-transfer-details");
  const downloadLinkLabel = document.querySelector("#download-link-label");
  const status = document.querySelector("#download-status");
  let downloadSource = "link";
  let selectedBrowseVideo = false;
  let sourceTransition = null;
  let activeDownload = null;

  function cancelCurrentDownload() {
    if (!activeDownload) return;
    activeDownload.cancelled = true;
    cancelButton.disabled = true;
    setStatus(status, "Cancelling download and cleaning up…");
    activeDownload.controller?.abort();
    if (activeDownload.jobId) {
      desktopDownloads.cancel(activeDownload.jobId).catch(() => { /* main process cleans stale jobs */ });
    }
  }
  cancelButton.addEventListener("click", cancelCurrentDownload);

  function setDownloadSource(source, { animate = false } = {}) {
    downloadSource = source;
    const browsing = source === "browse";
    youtubeLinkField.hidden = browsing;
    downloadFormatField.hidden = browsing;
    youtubeBrowsePanel.hidden = !browsing;
    if (browsing) youtubeSearchRow.after(videoQualityField);
    else downloadLinkRow.after(videoQualityField);
    downloadSourceBrowse.hidden = false;
    downloadLinkLabel.textContent = "YouTube link or search phrase";
    youtubeUrl.placeholder = "Paste a YouTube link or search, e.g. Apollo 11 highlights";
    youtubeUrl.required = !browsing;
    if (!browsing) selectedBrowseVideo = false;
    downloadSourceLink.classList.toggle("is-selected", !browsing);
    downloadSourceBrowse.classList.toggle("is-selected", browsing);
    downloadSourceLink.setAttribute("aria-pressed", String(!browsing));
    downloadSourceBrowse.setAttribute("aria-pressed", String(browsing));

    if (animate) {
      sourceTransition?.stop();
      const entering = browsing ? youtubeBrowsePanel : downloadLinkRow;
      sourceTransition = animateElement(entering, { opacity: [0, 1], y: [8, 0] }, {
        duration: 0.22,
        ease: MOTION_EASE,
      });
    }
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
      const download = document.createElement("button");
      download.className = "primary-button youtube-result-download";
      download.type = "button";
      download.textContent = "Download";
      const formats = document.createElement("div");
      formats.className = "youtube-result-formats";
      formats.hidden = true;
      for (const [kind, label] of [["audio", "Audio"], ["video", "Video"]]) {
        const chooseFormat = document.createElement("button");
        chooseFormat.className = "secondary-button";
        chooseFormat.type = "button";
        chooseFormat.textContent = label;
        chooseFormat.addEventListener("click", () => {
          youtubeUrl.value = video.url;
          downloadKind.value = kind;
          selectedBrowseVideo = true;
          youtubeSelectedTitle.textContent = video.title || "Selected video";
          youtubeSelectedVideo.hidden = false;
          form.requestSubmit();
        });
        formats.append(chooseFormat);
      }
      download.addEventListener("click", () => { formats.hidden = !formats.hidden; });
      actions.append(download, formats);
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
    youtubeSearchStatus.textContent = "Searching YouTube on this device…";
    youtubeSearchResults.replaceChildren();
    try {
      const videos = await desktopDownloads.search(query);
      renderYouTubeResults(Array.isArray(videos) ? videos : []);
    } catch (error) {
      youtubeSearchStatus.textContent = error.message || "YouTube search failed.";
    } finally {
      youtubeSearchButton.disabled = false;
    }
  }

  downloadSourceLink.addEventListener("click", () => setDownloadSource("link", { animate: true }));
  downloadSourceBrowse.addEventListener("click", () => setDownloadSource("browse", { animate: true }));
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
    selectedBrowseVideo = false;
    youtubeSearchStatus.textContent = "";
  });
  youtubeUrl.addEventListener("input", () => {
    if (downloadSource === "link") {
      youtubeSelectedVideo.hidden = true;
      selectedBrowseVideo = false;
    }
  });

  window.addEventListener("puffin:download-pick", (event) => {
    const query = event.detail?.query?.trim();
    if (!query) return;
    setDownloadSource("browse", { animate: true });
    youtubeUrl.value = "";
    youtubeSelectedVideo.hidden = true;
    youtubeSearchQuery.value = query;
    youtubeSearchResults.replaceChildren();
    youtubeSearchStatus.textContent = "Searching YouTube for this pick…";
    searchYouTube();
  });

  setDownloadSource("link");
  setStatus(status, "");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const entered = youtubeUrl.value.trim();
    const hasSelectedBrowseResult = downloadSource !== "browse" || selectedBrowseVideo;
    if (!entered || !hasSelectedBrowseResult) {
      setStatus(status, downloadSource === "browse"
        ? "Search YouTube and choose Audio or Video on a result."
        : "Enter a YouTube link or a search phrase.");
      return;
    }

    const requestedKind = downloadKind.value;
    const selectedVideoHeight = videoHeightForSliderValue(videoQuality.value);
    const requestedVideoHeight = requestedKind === "video" ? selectedVideoHeight : null;
    submitButton.disabled = true;
    cancelButton.hidden = false;
    cancelButton.disabled = false;
    activeDownload = { cancelled: false, controller: new AbortController(), jobId: null };
    progress.hidden = false;
    progress.value = 0;
    progressDetails.hidden = false;
    progressDetails.textContent = "Preparing the on-device downloader…";

    let jobId = null;
    let savedLocally = false;

    try {
      const capacity = await getMediaStorageCapacity();
      if (capacity.remainingBytes <= 0) {
        throw new Error("Puffin media storage limit reached. Delete files or raise the limit before downloading.");
      }
      setStatus(status, "Starting the on-device downloader…");
      const job = await desktopDownloads.start({
        target: entered,
        kind: requestedKind,
        videoHeight: selectedVideoHeight,
        subtitleLanguage: navigator.language || "en",
      });
      jobId = job.jobId;
      activeDownload.jobId = jobId;
      if (activeDownload.cancelled) throw new DOMException("Download cancelled.", "AbortError");

      const ready = await waitForJob(desktopDownloads, jobId, {
        signal: activeDownload.controller.signal,
        onStage: (payload) => {
          progress.value = Number(payload.progress) || 0;
          const { label, detail } = describeDownloadStage(payload);
          setStatus(status, label);
          progressDetails.textContent = detail;
        },
      });
      if (activeDownload.cancelled) throw new DOMException("Download cancelled.", "AbortError");
      if (requestedKind === "video" && ready.kind !== "video") {
        throw new Error("The downloader returned an audio file for a video request. Please retry.");
      }
      if (requestedKind === "video" && !String(ready.mime || "").startsWith("video/")) {
        throw new Error("The downloader did not produce a video file for this request.");
      }
      if (requestedKind === "audio" && !String(ready.mime || "").startsWith("audio/")) {
        throw new Error("The downloader did not produce an audio file for this request.");
      }
      if (requestedVideoHeight !== null) {
        if (!Number.isInteger(ready.height)) {
          throw new Error("Puffin could not verify the downloaded video's resolution. Please retry.");
        }
        if (ready.height > requestedVideoHeight) {
          throw new Error(`Puffin downloaded ${ready.height}p, above the selected ${videoHeightLabel(requestedVideoHeight)} maximum. The file was rejected.`);
        }
      }

      try {
        await guardReadyDownload({
          fileSize: (Number(ready.size) || 0) + (Number(ready.subtitleSize) || 0),
          assertCapacity: assertMediaStorageCapacity,
          cancelDownload: () => desktopDownloads.cancel(jobId),
        });
      } catch (error) {
        jobId = null;
        throw error;
      }

      progress.value = 100;
      const actualVideoDescription = requestedVideoHeight === null
        ? ""
        : `${videoHeightLabel(ready.height)} video (maximum ${videoHeightLabel(requestedVideoHeight)})`;
      progressDetails.textContent = `${actualVideoDescription ? `${actualVideoDescription} · ` : ""}Download complete · Saving to your Puffin library`;
      setStatus(status, "Copying the finished file into Puffin…");
      const fileResponse = await fetch(`puffin-media://download/${encodeURIComponent(jobId)}`, { signal: activeDownload.controller.signal });
      if (!fileResponse.ok) throw new Error(`Puffin could not copy the downloaded file (${fileResponse.status}).`);

      const localMedia = await readDirectMedia(fileResponse, youtubeUrl.value.trim(), capacity, ({ received, total, speed, eta }) => {
        progress.value = total ? Math.min(100, (received / total) * 100) : 0;
        if (!total) progress.removeAttribute("value");
        else progress.setAttribute("value", String(progress.value));
        const amount = total ? `${formatBytes(received)} of ${formatBytes(total)}` : `${formatBytes(received)} received`;
        progressDetails.textContent = `${amount} · ${formatBytes(speed)}/s · ${eta === null ? "time remaining unavailable" : `${formatTime(eta)} remaining`}`;
        setStatus(status, "Copying the finished file into Puffin…");
      });
      if (activeDownload.cancelled) throw new DOMException("Download cancelled.", "AbortError");
      cancelButton.disabled = true;
      const mediaBlob = localMedia.blob;
      setStatus(status, "Saving to this device…");
      let filename = localMedia.name || ready.filename || `puffin-download.${requestedKind === "audio" ? "m4a" : "mp4"}`;
      filename = removeLastBracketedPart(filename);
      if (ready.kind === "video") filename = filename.replace(/\.f\d+(?=\.[^.]+$)/i, "");

      try {
        if (navigator.storage?.persist) await navigator.storage.persist();
      } catch {
        // IndexedDB can still save the file when persistent storage is unavailable.
      }
      const artwork = ready.kind === "video" ? await videoFrameArtwork(mediaBlob) : "";
      let subtitles = "";
      if (ready.kind === "video" && ready.subtitlesAvailable) {
        try {
          const subtitle = await desktopDownloads.getSubtitles(jobId);
          const subtitleText = subtitle?.text || "";
          if (/^\uFEFF?WEBVTT(?:\s|$)/i.test(subtitleText)) subtitles = subtitleText;
          else console.warn("The on-device downloader returned an invalid WebVTT subtitle file.");
        } catch (subtitleError) {
          if (subtitleError.name === "AbortError") throw subtitleError;
          console.warn("Could not read the downloaded subtitles:", subtitleError);
        }
      }

      const savedRecord = await saveMediaFile(mediaBlob, {
        name: filename,
        type: ready.mime || mediaBlob.type,
        artwork,
        subtitles,
        subtitleLanguage: ready.subtitleLanguage || "en",
        rawTitle: filename.replace(/\.f\d+(?=\.[^.]+$)/i, "").replace(/\.[^.]+$/, ""),
      });
      if (savedRecord.kind === "audio") window.dispatchEvent(new CustomEvent("puffin:download-saved", { detail: savedRecord }));
      savedLocally = true;
      recordPuffinActivity("downloads").catch((statsError) => console.warn("Could not record completed download:", statsError));
      window.dispatchEvent(new Event("puffin:library-updated"));

      try {
        await desktopDownloads.complete(jobId);
        jobId = null;
      } catch (cleanupError) {
        console.warn("Puffin could not remove the temporary download:", cleanupError);
      }
      const savedResolution = actualVideoDescription ? `${actualVideoDescription} ` : "";
      setStatus(status, `Saved ${savedResolution}to your Puffin library on this device.`);
    } catch (error) {
      setStatus(status, activeDownload.cancelled || error.name === "AbortError" ? "Download cancelled. Partial transfer was discarded."
        : error.message || "The download failed.");
      if (jobId && !savedLocally && !activeDownload.cancelled && !(error instanceof MediaCapacityError)) {
        recordPuffinActivity("failedJobs", 1, error.message || "The download failed.").catch((statsError) => console.warn("Could not record download failure:", statsError));
      }
      if (jobId && !savedLocally) {
        try {
          await desktopDownloads.cancel(jobId);
        } catch {
          // The main process retries stale temporary files on the next launch.
        }
      }
    } finally {
      submitButton.disabled = false;
      cancelButton.hidden = true;
      cancelButton.disabled = false;
      activeDownload = null;
      progress.hidden = true;
      progressDetails.hidden = true;
    }
  });
}
