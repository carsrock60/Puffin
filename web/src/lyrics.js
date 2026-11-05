const LRCLIB_API = "https://lrclib.net/api";
const CLIENT_HEADER = "Puffin/1.0 (https://github.com/carsrock60/Puffin)";
const lyricState = new WeakMap();

let requestQueue = Promise.resolve();
let lastRequestAt = 0;
let serviceBlockedUntil = 0;

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function parseRetryAfter(value) {
  if (!value) return 1;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1, seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - Date.now()) / 1000)) : 1;
}

function requestLyrics(url) {
  const request = requestQueue.then(async () => {
    const waitFor = Math.max(lastRequestAt + 350, serviceBlockedUntil) - Date.now();
    if (waitFor > 0) await delay(waitFor);
    lastRequestAt = Date.now();

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-User-Agent": CLIENT_HEADER,
      },
    });
    if (response.status === 404) return null;
    if (response.status === 429 || response.status === 503) {
      const seconds = parseRetryAfter(response.headers.get("Retry-After"));
      serviceBlockedUntil = Date.now() + seconds * 1000;
      throw new Error(`LRCLIB asks clients to wait ${seconds} second${seconds === 1 ? "" : "s"} before trying again.`);
    }
    if (!response.ok) throw new Error(`LRCLIB request failed (${response.status}).`);
    return response.json();
  });
  requestQueue = request.catch(() => {});
  return request;
}

function normalizeForMatch(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function selectSyncedLyricsMatch(results, { trackName, artistName, albumName = "", duration }) {
  if (!Array.isArray(results)) return null;
  const title = normalizeForMatch(trackName);
  const artist = normalizeForMatch(artistName);
  const album = normalizeForMatch(albumName);
  const durationSeconds = Number(duration);
  const hasDuration = Number.isFinite(durationSeconds) && durationSeconds > 0;
  const matchDuration = hasDuration ? Math.round(durationSeconds) : Number.NaN;
  const candidates = results.filter((result) => {
    if (!result?.syncedLyrics) return false;
    const candidateTitle = normalizeForMatch(result.trackName || result.name);
    const candidateArtist = normalizeForMatch(result.artistName);
    if (candidateTitle !== title || candidateArtist !== artist) return false;
    const candidateDuration = typeof result.duration === "number" ? result.duration : Number.NaN;
    if (hasDuration && (!Number.isFinite(candidateDuration) || Math.abs(candidateDuration - matchDuration) > 2)) return false;
    return true;
  });
  candidates.sort((first, second) => {
    const firstDuration = hasDuration ? Math.abs(first.duration - matchDuration) : 0;
    const secondDuration = hasDuration ? Math.abs(second.duration - matchDuration) : 0;
    const firstAlbum = album && normalizeForMatch(first.albumName) === album ? 0 : 1;
    const secondAlbum = album && normalizeForMatch(second.albumName) === album ? 0 : 1;
    return firstAlbum - secondAlbum || firstDuration - secondDuration;
  });
  return candidates[0] || null;
}

export async function fetchSyncedLyrics({ trackName, artistName, albumName = "", duration }) {
  const cleanTrackName = String(trackName || "").trim();
  const cleanArtistName = String(artistName || "").trim();
  if (!cleanTrackName || !cleanArtistName) {
    throw new Error("Add both a song title and artist before looking up lyrics.");
  }
  const durationSeconds = Number(duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 3600) {
    throw new Error("Puffin couldn’t read this track’s duration, so it can’t safely match synchronized lyrics.");
  }

  const exactParams = new URLSearchParams({ track_name: cleanTrackName, artist_name: cleanArtistName });
  const searchParams = new URLSearchParams({ track_name: cleanTrackName, artist_name: cleanArtistName });
  if (albumName) {
    exactParams.set("album_name", String(albumName).trim());
    searchParams.set("album_name", String(albumName).trim());
  }
  exactParams.set("duration", String(Math.round(durationSeconds)));

  const exactMatch = await requestLyrics(`${LRCLIB_API}/get?${exactParams}`);
  if (selectSyncedLyricsMatch(exactMatch ? [exactMatch] : [], {
    trackName: cleanTrackName,
    artistName: cleanArtistName,
    albumName,
    duration: durationSeconds,
  })) return exactMatch;

  const searchMatch = await requestLyrics(`${LRCLIB_API}/search?${searchParams}`);
  const result = selectSyncedLyricsMatch(Array.isArray(searchMatch) ? searchMatch : [], {
    trackName: cleanTrackName,
    artistName: cleanArtistName,
    albumName,
    duration: durationSeconds,
  });
  if (result) return result;

  const instrumental = Array.isArray(searchMatch) && searchMatch.some((item) => item.instrumental
    && normalizeForMatch(item.trackName || item.name) === normalizeForMatch(cleanTrackName));
  throw new Error(instrumental
    ? "LRCLIB marks this track as instrumental; it has no synchronized lyrics."
    : "No matching synchronized lyrics were found. Check the title and artist and try again.");
}

export function parseSyncedLyrics(lrcText) {
  const text = String(lrcText || "").replace(/^\uFEFF/, "");
  const offset = Number(text.match(/^\[offset:\s*([+-]?\d+)\s*\]\s*$/im)?.[1] || 0);
  const timestampPattern = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  const lines = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const stamps = [...rawLine.matchAll(timestampPattern)];
    const content = rawLine.replace(timestampPattern, "").trim();
    if (!content || stamps.length === 0) continue;
    stamps.forEach((stamp) => {
      const fraction = (stamp[3] || "").padEnd(3, "0").slice(0, 3);
      const timestamp = Math.max(0, Number(stamp[1]) * 60 + Number(stamp[2]) + Number(`0.${fraction || "0"}`) - offset / 1000);
      lines.push({ time: timestamp, text: content });
    });
  }
  return lines.sort((first, second) => first.time - second.time);
}

export function renderSyncedLyrics(container, lrcText, timingAdjustmentMs = 0) {
  const adjustmentSeconds = Number.isFinite(Number(timingAdjustmentMs)) ? Number(timingAdjustmentMs) / 1000 : 0;
  const lines = parseSyncedLyrics(lrcText)
    .map((line) => ({ ...line, time: Math.max(0, line.time + adjustmentSeconds) }))
    .sort((first, second) => first.time - second.time);
  const elements = lines.map((line) => {
    const item = document.createElement("li");
    item.dataset.time = String(line.time);
    item.textContent = line.text;
    return item;
  });
  container.replaceChildren(...elements);
  lyricState.set(container, { lines, elements, activeIndex: -1 });
  return lines.length;
}

export function findSyncedLyricIndex(lines, currentTime) {
  if (!Array.isArray(lines) || !Number.isFinite(currentTime)) return -1;
  let low = 0;
  let high = lines.length - 1;
  let active = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lines[middle].time <= currentTime) {
      active = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return active;
}

export function syncSyncedLyrics(container, currentTime) {
  const state = lyricState.get(container);
  if (!state || state.lines.length === 0 || !Number.isFinite(currentTime)) return;
  const active = findSyncedLyricIndex(state.lines, currentTime);
  if (active === state.activeIndex) return;
  state.elements[state.activeIndex]?.removeAttribute("aria-current");
  state.elements[state.activeIndex]?.classList.remove("is-active");
  state.activeIndex = active;
  if (active >= 0) {
    state.elements[active].setAttribute("aria-current", "true");
    state.elements[active].classList.add("is-active");
    const containerRect = container.getBoundingClientRect();
    const lineRect = state.elements[active].getBoundingClientRect();
    const centeredTop = container.scrollTop + lineRect.top - containerRect.top
      - (container.clientHeight - lineRect.height) / 2;
    container.scrollTop = Math.max(0, centeredTop);
  }
}
