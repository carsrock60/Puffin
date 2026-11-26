/**
 * Pure helpers for Puffin Discover.
 *
 * These functions build the smallest useful listening profile for the
 * backend and keep the client-side cache behavior deterministic. They have no
 * DOM or IndexedDB dependencies so they can be covered by Node tests.
 */

export const DISCOVERY_CACHE_KEY = "puffin.discover.cache.v1";
export const DISCOVERY_SEEN_KEY = "puffin.discover.seen.v1";
export const DISCOVERY_CACHE_TTL_MS = 30 * 60 * 1000;
export const DISCOVERY_MIN_REFRESH_MS = 5 * 60 * 1000;
export const DISCOVERY_SEEN_LIMIT = 80;
export const DISCOVERY_SEED_LIMIT = 8;
export const DISCOVERY_KNOWN_LIMIT = 40;

export function normalizeDiscoveryName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function displayTitle(record) {
  const title = String(record?.title || "").trim();
  if (title) return title;
  return String(record?.name || "").replace(/\.[^.]+$/, "").trim();
}

function hashText(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function playCountsByMedia(stats) {
  const counts = new Map();
  const days = stats?.days && typeof stats.days === "object" ? stats.days : {};
  for (const day of Object.values(days)) {
    const trackPlays = day?.trackPlays && typeof day.trackPlays === "object" ? day.trackPlays : {};
    for (const [mediaId, rawCount] of Object.entries(trackPlays)) {
      const count = Number(rawCount);
      if (!mediaId || !Number.isFinite(count) || count <= 0) continue;
      counts.set(mediaId, (counts.get(mediaId) || 0) + count);
    }
  }
  return counts;
}

export function buildDiscoveryProfile(records = [], stats = {}, recentlyPlayed = [], now = Date.now()) {
  const audioRecords = (Array.isArray(records) ? records : []).filter((record) => record && record.kind === "audio");
  const playCounts = playCountsByMedia(stats);
  const recentRanks = new Map();
  (Array.isArray(recentlyPlayed) ? recentlyPlayed : []).forEach((record, index) => {
    if (record?.kind !== "audio" || !record.id || recentRanks.has(record.id)) return;
    recentRanks.set(record.id, index);
  });

  const groups = new Map();
  for (const record of audioRecords) {
    const name = String(record.artist || "").trim();
    const key = normalizeDiscoveryName(name);
    if (!key) continue;
    let group = groups.get(key);
    if (!group) {
      group = { key, name, tracks: [], playCount: 0, libraryCount: 0, recentRank: null, lastAddedAt: 0, score: 0, sampleTracks: [] };
      groups.set(key, group);
    }
    group.tracks.push(record);
    group.libraryCount += 1;
    group.playCount += playCounts.get(record.id) || 0;
    const addedAt = Number(record.importedAt || record.addedAt || 0);
    if (Number.isFinite(addedAt)) group.lastAddedAt = Math.max(group.lastAddedAt, addedAt);
    const rank = recentRanks.get(record.id);
    if (Number.isInteger(rank)) group.recentRank = group.recentRank == null ? rank : Math.min(group.recentRank, rank);
  }

  for (const group of groups.values()) {
    const trackScores = group.tracks
      .map((record) => ({ record, plays: playCounts.get(record.id) || 0 }))
      .sort((a, b) => b.plays - a.plays || displayTitle(a.record).localeCompare(displayTitle(b.record)));
    const seenTitles = new Set();
    for (const item of trackScores) {
      const title = displayTitle(item.record);
      const key = title.toLocaleLowerCase();
      if (!title || seenTitles.has(key)) continue;
      seenTitles.add(key);
      group.sampleTracks.push(title);
      if (group.sampleTracks.length >= 2) break;
    }
    const history = Math.log1p(group.playCount);
    const recency = group.recentRank == null ? 0 : Math.max(0, 1 - group.recentRank / 30);
    const libraryWeight = Math.log1p(group.libraryCount);
    const addedRecently = group.lastAddedAt > 0 ? Math.max(0, 1 - Math.min(1, (now - group.lastAddedAt) / (90 * 86400000))) : 0;
    group.score = history * 1.2 + recency * 1.4 + libraryWeight * 0.35 + addedRecently * 0.15;
  }

  const artists = [...groups.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const seedArtists = artists.slice(0, DISCOVERY_SEED_LIMIT);
  const seedKeys = new Set(seedArtists.map((artist) => artist.key));
  const seeds = seedArtists.map((artist) => ({
    name: artist.name,
    playCount: Math.floor(artist.playCount),
    libraryCount: artist.libraryCount,
    recentRank: artist.recentRank,
    sampleTracks: artist.sampleTracks.slice(0, 2),
  }));
  const knownArtists = artists
    .filter((artist) => artist.libraryCount >= 2 && !seedKeys.has(artist.key))
    .slice(0, DISCOVERY_KNOWN_LIMIT)
    .map((artist) => artist.name);
  const hasListeningHistory = artists.some((artist) => artist.playCount > 0);
  const profile = {
    seeds,
    knownArtists,
    hasLibrary: audioRecords.length > 0,
    hasListeningHistory,
    artistCount: artists.length,
    trackCount: audioRecords.length,
  };
  profile.signature = discoveryProfileSignature(profile);
  return profile;
}

export function discoveryProfileSignature(profile) {
  const seedText = (profile?.seeds || [])
    .map((seed) => [
      normalizeDiscoveryName(seed.name),
      Number(seed.playCount) || 0,
      Number(seed.libraryCount) || 0,
      seed.recentRank == null ? "" : Number(seed.recentRank),
      (seed.sampleTracks || []).join("~"),
    ].join(":"))
    .join("\n");
  const knownText = (profile?.knownArtists || []).map(normalizeDiscoveryName).sort().join("|");
  return hashText(`${seedText}\n${knownText}\n${profile?.hasListeningHistory ? 1 : 0}`);
}

export function isDiscoveryCacheFresh(cache, profile, now = Date.now(), ttl = DISCOVERY_CACHE_TTL_MS) {
  if (!cache?.payload || !Array.isArray(cache.payload.recommendations) || !cache.payload.recommendations.length) return false;
  if (!Number.isFinite(cache.savedAt) || now - cache.savedAt > ttl || now < cache.savedAt) return false;
  return Boolean(profile) && cache.profileSignature === profile.signature;
}

export function isDiscoveryCacheUsable(cache) {
  return Boolean(cache?.payload && Array.isArray(cache.payload.recommendations) && cache.payload.recommendations.length);
}

export function mergeSeenArtists(existing, recommendations, limit = DISCOVERY_SEEN_LIMIT) {
  const names = [];
  const seen = new Set();
  const add = (value) => {
    const name = String(value || "").trim();
    const key = normalizeDiscoveryName(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    names.push(name);
  };
  for (const recommendation of recommendations || []) add(recommendation?.name);
  for (const name of Array.isArray(existing) ? existing : []) add(name);
  return names.slice(0, limit);
}

export function discoverySeedContext(profile, limit = 3) {
  const names = (profile?.seeds || []).map((seed) => seed.name).filter(Boolean);
  if (!names.length) return "";
  if (names.length <= limit) {
    if (names.length === 1) return `Inspired by ${names[0]}`;
    return `Inspired by ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  return `Inspired by ${names.slice(0, limit).join(", ")} and more`;
}
