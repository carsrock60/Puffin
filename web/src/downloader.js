import { assertMediaStorageCapacity, getMediaStorageCapacity, recordPuffinActivity, saveMediaFile } from "./library.js";
import { formatBytes, guardReadyPiDownload, MediaCapacityError } from "./media-capacity.js";

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

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"' && cell.length === 0) quoted = true;
    else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  if (quoted) throw new Error("The CSV has an unclosed quoted field.");
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function selectCsvRows(rows, selector) {
  if (!selector.trim()) return rows;
  const selected = new Set();
  for (const part of selector.split(",").map((value) => value.trim()).filter(Boolean)) {
    const range = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!range) throw new Error("Enter row numbers like 1,3-5, or leave blank to download all rows.");
    const start = Number(range[1]);
    const end = Number(range[2] || range[1]);
    if (start < 1 || end < start || end > rows.length) throw new Error(`Row range ${part} is outside 1–${rows.length}.`);
    for (let value = start; value <= end; value += 1) selected.add(value);
  }
  return [...selected].sort((a, b) => a - b).map((number) => rows[number - 1]);
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

export function initializeDownloader() {
  const form = document.querySelector("#download-form");
  const piAddress = document.querySelector("#settings-pi-address");
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
  const submitButton = document.querySelector("#start-download");
  const cancelButton = document.querySelector("#cancel-download");
  const progress = document.querySelector("#download-progress");
  const progressDetails = document.querySelector("#download-transfer-details");
  const downloadLinkLabel = document.querySelector("#download-link-label");
  const csvFile = document.querySelector("#download-csv-file");
  const csvRowsField = document.querySelector("#download-csv-rows");
  const csvPrepareButton = document.querySelector("#download-csv-prepare");
  const csvStartButton = document.querySelector("#download-csv-start");
  const csvStatus = document.querySelector("#download-csv-status");
  const status = document.querySelector("#download-status");
  let downloadSource = "link";
  let selectedBrowseVideo = false;
  let activeDownload = null;
  let loadedCsvRows = [];
  let csvBatch = null;

  csvPrepareButton.addEventListener("click", async () => {
    const file = csvFile.files?.[0];
    if (!file) {
      csvStatus.textContent = "Choose a CSV file first.";
      return;
    }
    csvPrepareButton.disabled = true;
    try {
      const records = parseCsv(await file.text());
      if (records.length < 2) throw new Error("The CSV needs a header row and at least one track row.");
      const headers = records[0].map((header) => header.trim().toLowerCase());
      const columns = {
        track: headers.indexOf("track name"),
        artist: headers.indexOf("artist name"),
        album: headers.indexOf("album"),
      };
      if (Object.values(columns).some((index) => index < 0)) {
        throw new Error("Required columns: Track Name, Artist Name, and Album.");
      }
      loadedCsvRows = records.slice(1).map((record, index) => ({
        rowNumber: index + 1,
        track: (record[columns.track] || "").trim(),
        artist: (record[columns.artist] || "").trim(),
        album: (record[columns.album] || "").trim(),
      }));
      const validCount = loadedCsvRows.filter((row) => row.track && row.artist).length;
      if (!validCount) throw new Error("No rows have both a Track Name and Artist Name.");
      csvStartButton.disabled = false;
      csvStatus.textContent = `Loaded ${validCount} tracks across ${loadedCsvRows.length} data rows. Blank or incomplete rows will be skipped.`;
    } catch (error) {
      loadedCsvRows = [];
      csvStartButton.disabled = true;
      csvStatus.textContent = error.message || "Could not read this CSV file.";
    } finally {
      csvPrepareButton.disabled = false;
    }
  });

  function startNextCsvTrack() {
    if (!csvBatch) return;
    if (csvBatch.cancelled) {
      csvStatus.textContent = `CSV queue cancelled after ${csvBatch.index} of ${csvBatch.items.length} tracks.`;
      csvBatch = null;
      csvStartButton.disabled = false;
      return;
    }
    if (csvBatch.index >= csvBatch.items.length) {
      csvStatus.textContent = `CSV downloads finished: ${csvBatch.items.length - csvBatch.failed} succeeded, ${csvBatch.failed} failed.`;
      csvBatch = null;
      csvStartButton.disabled = false;
      return;
    }
    const item = csvBatch.items[csvBatch.index];
    setDownloadSource("link");
    youtubeUrl.value = `ytsearch: ${item.track} - ${item.artist}${item.album ? ` ${item.album}` : ""}`;
    selectedBrowseVideo = false;
    setStatus(status, `CSV row ${item.rowNumber} · track ${csvBatch.index + 1} of ${csvBatch.items.length}`);
    form.requestSubmit();
  }

  csvStartButton.addEventListener("click", () => {
    if (activeDownload || csvBatch) return;
    try {
      const selectedRows = selectCsvRows(loadedCsvRows, csvRowsField.value);
      const items = selectedRows.filter((row) => row.track && row.artist);
      if (!items.length) throw new Error("The selected rows contain no complete track and artist entries.");
      csvBatch = { items, index: 0, failed: 0, cancelled: false };
      csvStartButton.disabled = true;
      csvStatus.textContent = `Starting ${items.length} downloads in order…`;
      startNextCsvTrack();
    } catch (error) {
      csvStatus.textContent = error.message;
    }
  });

  cancelButton.addEventListener("click", async () => {
    if (!activeDownload) return;
    activeDownload.cancelled = true;
    if (csvBatch) csvBatch.cancelled = true;
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
    youtubeBrowsePanel.hidden = !browsing;
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
      youtubeSearchStatus.textContent = "Search YouTube and choose audio or video from a result.";
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
    setStatus(status, "Downloads run through your Raspberry Pi. Enter a YouTube link or search phrase, or browse YouTube.");
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
      await checkPi(baseUrl);

      const downloadTarget = /^https?:\/\//i.test(entered)
        ? entered
        : (entered.startsWith("ytsearch:") || entered.startsWith("ytsearch1:") ? entered : `ytsearch:${entered}`);
      const job = await requestJson(baseUrl, "/api/downloads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: downloadTarget,
          kind: downloadKind.value,
          supported_audio_formats: downloadKind.value === "audio" ? getSupportedAudioFormats() : [],
        }),
      });
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
          setStatus(status, "Converting media on the Pi…");
          progressDetails.textContent = "Converting media on the Pi…";
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
      progressDetails.textContent = "Download complete · Saving to your Puffin library";
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
      let filename = piMedia.name || `puffin-download.${downloadKind.value === "audio" ? "m4a" : "mp4"}`;
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
      recordPuffinActivity("downloads").catch((statsError) => console.warn("Could not record completed download:", statsError));
      window.dispatchEvent(new Event("puffin:library-updated"));

      try {
        const cleanedUp = await confirmPiSavedFile(baseUrl, jobId);
        if (cleanedUp) setStatus(status, "Saved to your Puffin library on this device.");
        else setStatus(status, "Saved locally. The Pi will remove its temporary copy after it expires.");
      } catch {
        setStatus(status, "Saved locally. The Pi could not confirm cleanup; its temporary copy will expire automatically.");
      }
    } catch (error) {
      if (csvBatch && !activeDownload.cancelled) csvBatch.failed += 1;
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
      const wasCancelled = activeDownload?.cancelled;
      submitButton.disabled = false;
      cancelButton.hidden = true;
      cancelButton.disabled = false;
      activeDownload = null;
      progress.hidden = true;
      progressDetails.hidden = true;
      if (csvBatch) {
        if (wasCancelled) csvBatch.cancelled = true;
        else csvBatch.index += 1;
        window.setTimeout(startNextCsvTrack, 300);
      }
    }
  });
}
