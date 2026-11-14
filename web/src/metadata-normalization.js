export const ENRICHMENT_POLICY = Object.freeze({ minAiScore: 0.90, maxDurationDeltaSeconds: 3, aiTitleConfidence: 0.75 });
const MUSICBRAINZ_MIN_INTERVAL_MS = 1100;
let musicBrainzTail = Promise.resolve();
let lastMusicBrainzRequestAt = 0;

// MusicBrainz asks clients to keep request rates low. Serialize requests in this
// tab so enrichment and manual metadata searches do not burst together.
export async function fetchMusicBrainz(url, options = {}, fetcher = fetch) {
  const request = musicBrainzTail.then(async () => {
    const waitMs = Math.max(0, MUSICBRAINZ_MIN_INTERVAL_MS - (Date.now() - lastMusicBrainzRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastMusicBrainzRequestAt = Date.now();
    const response = await fetcher(url, options);
    if (!response.ok) {
      const error = new Error(`MusicBrainz returned ${response.status}.`);
      error.status = response.status;
      const retryAfter = response.headers?.get?.("Retry-After");
      if (retryAfter) {
        const seconds = Number(retryAfter);
        const dateDelay = Date.parse(retryAfter) - Date.now();
        error.retryAfterMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, dateDelay || 0);
      }
      throw error;
    }
    return response;
  });
  musicBrainzTail = request.catch(() => {});
  return request;
}

export function stripYoutubeId(value) { return String(value || "").replace(/\s*\[[\w-]{8,}\](?=\s|\.[^.]+$|$)/g, " ").replace(/\s+/g, " ").replace(/\s+\./g, ".").trim(); }
export function cleanYoutubeTitle(value) {
  return stripYoutubeId(value).replace(/\b(official\s+)?(music\s+video|audio|lyrics?|visuali[sz]er|4k|hd|official video|video clip)\b/gi, " ").replace(/[|–—]+\s*[^|–—]+$/g, " ").replace(/[()[\]{}]/g, " ").replace(/\s+/g, " ").trim();
}

export async function normalizeTrackTitle(rawTitle, fetcher = fetch) {
  const cleaned = cleanYoutubeTitle(rawTitle);
  const split = cleaned.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  const fallback = { title: split?.[2]?.trim() || cleaned, artist: split?.[1]?.trim() || "", version: "", confidence: 0 };
  try {
    const response = await fetcher("/api/smart-fill/normalize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw_title: stripYoutubeId(rawTitle).slice(0, 500) }), signal: AbortSignal.timeout(30000) });
    if (!response.ok) return fallback;
    const value = await response.json();
    if (typeof value.title !== "string" || !value.title.trim() || typeof value.artist !== "string" || !Number.isFinite(value.confidence) || value.confidence < ENRICHMENT_POLICY.aiTitleConfidence) return fallback;
    return { ...value, title: value.title.trim(), artist: value.artist.trim() };
  } catch { return fallback; }
}

export async function searchMusicBrainzRecordings({ title, artist }, fetcher = fetch) {
  const quote = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
  const query = `recording:${quote(title)}${artist ? ` AND artist:${quote(artist)}` : ""}`;
  const response = await fetchMusicBrainz(`https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}&fmt=json&limit=8`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) }, fetcher);
  return response.json();
}
