import { assertMediaStorageCapacity, getMediaStorageCapacity, recordPuffinActivity, saveMediaFile } from "./library.js";
import { formatBytes, guardReadyPiDownload, MediaCapacityError } from "./media-capacity.js";
import { piSupportsVideoQuality, videoHeightForSliderValue, videoQualityLabel } from "./video-quality.js";

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

async function checkPi(baseUrl, requestedVideoHeight = null) {
  const health = await requestJson(baseUrl, "/api/health");
  if (!health.ok) throw new Error("The Pi service did not return a healthy status.");
  if (requestedVideoHeight !== null && !piSupportsVideoQuality(health, requestedVideoHeight)) {
    throw new Error("The Pi downloader is outdated and cannot apply the video quality slider. Update and restart the Pi downloader service, then retry.");
  }
}

function videoHeightLabel(height) {
  return height === 2160 ? "4K" : `${height}p`;
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
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/downloads/${jobId}`, { method: "DELETE" });
    if (response.ok || response.status === 404) return;
    if (response.status !== 409) throw new Error(`Pi cleanup failed (${response.status}).`);
    await sleep(250);
  }
  throw new Error("The Pi is still finishing the transfer. Its temporary file will expire automatically.");
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const rounded = Math.ceil(seconds);
  const minutes = Math.floor(rounded / 60);
  return minutes ? `${minutes}:${String(rounded % 60).padStart(2, "0")}` : `${rounded}s`;
}

function getSupportedAudioFormats() {
  const probe = document.createElement("audio");
  const candidates = {
    m4a: ['audio/mp4; codecs="mp4a.40.2"', "audio/x-m4a"],
    mp3: ["audio/mpeg"],
    webm: ['audio/webm; codecs="opus"'],
    opus: ['audio/ogg; codecs="opus"', "audio/opus"],
    ogg: ['audio/ogg; codecs="vorbis"'],
    oga: ['audio/ogg; codecs="vorbis"'],
    flac: ["audio/flac"],
    wav: ['audio/wav; codecs="1"', "audio/wav"],
    aac: ["audio/aac"],
    aiff: ["audio/aiff"],
  };
  return Object.entries(candidates)
    .filter(([, mimeTypes]) => mimeTypes.some((mimeType) => probe.canPlayType(mimeType) !== ""))
    .map(([extension]) => extension);
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
    throw new Error("This link did not return a recognizable audio or video file. Use a direct media-file URL.");
  }
  if (!response.body?.getReader) throw new Error("This browser cannot stream the response. Try the Raspberry Pi download option.");
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

export function initializeDownloader() {
  const form = document.querySelector("#download-form");
  const piAddress = document.querySelector("#settings-pi-address");
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
  let activeDownload = null;

  cancelButton.addEventListener("click", async () => {
    if (!activeDownload) return;
    activeDownload.cancelled = true;
    cancelButton.disabled = true;
    setStatus(status, "Cancelling download and cleaning up…");
    activeDownload.controller?.abort();
    if (activeDownload.baseUrl && activeDownload.jobId) {
      try {
        await cancelPiDownload(activeDownload.baseUrl, activeDownload.jobId);
      } catch (error) {
        setStatus(status, error.message || "Puffin could not confirm Pi cleanup.");
      }
    }
  });

  function setDownloadSource(source) {
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
    setDownloadSource("browse");
    youtubeUrl.value = "";
    youtubeSelectedVideo.hidden = true;
    youtubeSearchQuery.value = query;
    youtubeSearchResults.replaceChildren();
    youtubeSearchStatus.textContent = "Searching YouTube for this pick…";
    searchYouTube();
  });

  function applyDownloadPreferences() {
    setDownloadSource(downloadSource);
    setStatus(status, "");
  }
  window.addEventListener("puffin:download-preferences-updated", applyDownloadPreferences);
  applyDownloadPreferences();

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
    // Keep the user's format choice stable while the asynchronous download,
    // polling, and transfer steps run.
    const requestedKind = downloadKind.value;
    const selectedVideoHeight = videoHeightForSliderValue(videoQuality.value);
    const requestedVideoHeight = requestedKind === "video" ? selectedVideoHeight : null;
    submitButton.disabled = true;
    cancelButton.hidden = false;
    cancelButton.disabled = false;
    activeDownload = { cancelled: false, controller: new AbortController() };
    progress.hidden = false;
    progress.value = 0;
    progressDetails.hidden = false;
    progressDetails.textContent = "Preparing download…";

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
      setStatus(status, "Connecting to the Pi…");
      await checkPi(baseUrl, requestedVideoHeight);

      const downloadTarget = /^https?:\/\//i.test(entered)
        ? entered
        : (entered.startsWith("ytsearch:") || entered.startsWith("ytsearch1:") ? entered : `ytsearch:${entered}`);
      const job = await requestJson(baseUrl, "/api/downloads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: downloadTarget,
          kind: requestedKind,
          video_height: selectedVideoHeight,
          preferred_subtitle_language: navigator.language || "en",
          supported_audio_formats: requestedKind === "audio" ? getSupportedAudioFormats() : [],
        }),
      });
      if (requestedVideoHeight !== null && job.requested_video_height !== requestedVideoHeight) {
        await cancelPiDownload(baseUrl, job.id);
        throw new Error("The Pi did not accept the selected video resolution. Update and restart the Pi downloader service, then retry.");
      }
      jobId = job.id;
      activeDownload.baseUrl = baseUrl;
      activeDownload.jobId = jobId;
      if (activeDownload.cancelled) {
        await cancelPiDownload(baseUrl, jobId);
        throw new DOMException("Download cancelled.", "AbortError");
      }

      let currentJob = job;
      while (["queued", "downloading", "converting"].includes(currentJob.status)) {
        progress.value = currentJob.progress || 0;
        if (currentJob.status === "queued") {
          setStatus(status, "Pi download queued…");
          progressDetails.textContent = "Waiting for the Pi to start the download…";
        }
        else if (currentJob.status === "converting") {
          setStatus(status, "Combining video and audio on the Pi…");
          progressDetails.textContent = "Combining video and audio on the Pi…";
        }
        else if (currentJob.progress) {
          setStatus(status, `Downloading on the Pi · ${Math.round(currentJob.progress)}%`);
          const details = [currentJob.speed, currentJob.eta ? `${currentJob.eta} remaining` : ""].filter(Boolean);
          progressDetails.textContent = details.length ? details.join(" · ") : "Calculating transfer speed and remaining time…";
        }
        else setStatus(status, "Downloading on the Pi…");

        await sleep(1200);
        currentJob = await requestJson(baseUrl, `/api/downloads/${jobId}`);
      }

      if (currentJob.status !== "ready") {
        throw new Error(currentJob.error || "The Pi download did not finish.");
      }
      if (requestedKind === "video" && currentJob.kind !== "video") {
        throw new Error("The Pi returned an audio job for a video request. Please retry the download.");
      }
      if (requestedKind === "video" && !currentJob.mime_type?.startsWith("video/")) {
        throw new Error("The Pi did not produce a video file for this request.");
      }
      if (requestedVideoHeight !== null) {
        if (!Number.isInteger(currentJob.actual_video_height)) {
          throw new Error("The Pi could not verify the downloaded video's resolution. Update and restart the Pi downloader service, then retry.");
        }
        if (currentJob.actual_video_height > requestedVideoHeight) {
          throw new Error(`The Pi downloaded ${videoHeightLabel(currentJob.actual_video_height)}, above the selected ${videoHeightLabel(requestedVideoHeight)} maximum. The file was rejected.`);
        }
      }

      try {
        await guardReadyPiDownload({
          fileSize: currentJob.size + (currentJob.subtitle_size || 0),
          assertCapacity: assertMediaStorageCapacity,
          cancelDownload: () => cancelPiDownload(baseUrl, jobId),
        });
      } catch (error) {
        jobId = null;
        throw error;
      }

      progress.value = 100;
      const actualVideoDescription = requestedVideoHeight === null
        ? ""
        : `${videoHeightLabel(currentJob.actual_video_height)} video (maximum ${videoHeightLabel(requestedVideoHeight)})`;
      progressDetails.textContent = `${actualVideoDescription ? `${actualVideoDescription} · ` : ""}Download complete · Saving to your Puffin library`;
      setStatus(status, "Receiving file from the Pi…");
      transferStarted = true;
      const fileResponse = await fetch(`${baseUrl}/api/downloads/${jobId}/file`, { signal: activeDownload.controller.signal });
      if (!fileResponse.ok) {
        const payload = await responsePayload(fileResponse);
        throw new Error(payload.error || `File transfer failed (${fileResponse.status}).`);
      }

      const piMedia = await readDirectMedia(fileResponse, youtubeUrl.value.trim(), capacity, ({ received, total, speed, eta }) => {
        progress.value = total ? Math.min(100, (received / total) * 100) : 0;
        if (!total) progress.removeAttribute("value");
        else progress.setAttribute("value", String(progress.value));
        const amount = total ? `${formatBytes(received)} of ${formatBytes(total)}` : `${formatBytes(received)} received`;
        progressDetails.textContent = `${amount} · ${formatBytes(speed)}/s · ${eta === null ? "time remaining unavailable" : `${formatTime(eta)} remaining`}`;
        setStatus(status, "Receiving file from the Pi…");
      });
      if (activeDownload.cancelled) throw new DOMException("Download cancelled.", "AbortError");
      cancelButton.disabled = true;
      const mediaBlob = piMedia.blob;
      setStatus(status, "Saving to this device…");
      const encodedName = fileResponse.headers.get("X-Download-Name");
      let filename = piMedia.name || `puffin-download.${requestedKind === "audio" ? "m4a" : "mp4"}`;
      if (encodedName) {
        try {
          filename = decodeURIComponent(encodedName);
        } catch {
          filename = encodedName;
        }
      } else if (currentJob.filename) {
        filename = currentJob.filename;
      }
      filename = removeLastBracketedPart(filename);
      if (currentJob.kind === "video") filename = filename.replace(/\.f\d+(?=\.[^.]+$)/i, "");

      try {
        if (navigator.storage?.persist) await navigator.storage.persist();
      } catch {
        // IndexedDB can still save the file when persistent storage is unavailable.
      }
      const artwork = currentJob.kind === "video" ? await videoFrameArtwork(mediaBlob) : "";
      let subtitles = "";
      if (currentJob.kind === "video" && currentJob.subtitles_available) {
        try {
          const subtitleResponse = await fetch(`${baseUrl}/api/downloads/${jobId}/subtitles`, { signal: activeDownload.controller.signal });
          if (subtitleResponse.ok) {
            const subtitleText = await subtitleResponse.text();
            if (/^\uFEFF?WEBVTT(?:\s|$)/i.test(subtitleText)) subtitles = subtitleText;
            else console.warn("The Pi returned an invalid WebVTT subtitle file.");
          } else if (subtitleResponse.status !== 404) {
            console.warn(`Could not receive subtitles from the Pi (${subtitleResponse.status}).`);
          }
        } catch (subtitleError) {
          if (subtitleError.name === "AbortError") throw subtitleError;
          console.warn("Could not receive subtitles from the Pi:", subtitleError);
        }
      } else if (currentJob.kind === "video") {
        console.info("[Puffin download] The Pi found no downloadable WebVTT subtitles for this video.", { jobId });
      }
      const savedRecord = await saveMediaFile(mediaBlob, {
        name: filename,
        type: currentJob.mime_type || mediaBlob.type,
        artwork,
        subtitles,
        subtitleLanguage: currentJob.subtitle_language || "en",
        rawTitle: filename.replace(/\.f\d+(?=\.[^.]+$)/i, "").replace(/\.[^.]+$/, ""),
      });
      if (savedRecord.kind === "audio") window.dispatchEvent(new CustomEvent("puffin:download-saved", { detail: savedRecord }));
      savedLocally = true;
      recordPuffinActivity("downloads").catch((statsError) => console.warn("Could not record completed download:", statsError));
      window.dispatchEvent(new Event("puffin:library-updated"));

      const savedResolution = actualVideoDescription ? `${actualVideoDescription} ` : "";
      try {
        const cleanedUp = await confirmPiSavedFile(baseUrl, jobId);
        if (cleanedUp) setStatus(status, `Saved ${savedResolution}to your Puffin library on this device.`);
        else setStatus(status, `Saved ${savedResolution}locally. The Pi will remove its temporary copy after it expires.`);
      } catch {
        setStatus(status, `Saved ${savedResolution}locally. The Pi could not confirm cleanup; its temporary copy will expire automatically.`);
      }
    } catch (error) {
      setStatus(status, activeDownload.cancelled || error.name === "AbortError" ? "Download cancelled. Partial transfer was discarded."
        : error.message || "The download failed.");
      if (jobId && !savedLocally && !activeDownload.cancelled && !(error instanceof MediaCapacityError)) {
        recordPuffinActivity("failedJobs", 1, error.message || "The download failed.").catch((statsError) => console.warn("Could not record download failure:", statsError));
      }
      if (jobId && baseUrl && !savedLocally && !activeDownload.cancelled) {
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
      cancelButton.hidden = true;
      cancelButton.disabled = false;
      activeDownload = null;
      progress.hidden = true;
      progressDetails.hidden = true;
    }
  });
}
