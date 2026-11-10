import { listMediaFiles, listRecentlyPlayed, listPlaylists } from "./library.js";
import { getHomePreferences } from "./home-preferences.js";

const stripExtension = (name) => name.replace(/\.[^.]+$/, "");
const normalize = (value) => String(value || "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
const recommendationCache = new Map();
const artworkCache = new Map();

function recommendationKey(artist, title) {
  return `${normalize(artist)}\u0000${normalize(title)}`;
}

async function recommendationArtwork(artist, title) {
  const key = recommendationKey(artist, title);
  if (artworkCache.has(key)) return artworkCache.get(key);
  try {
    const query = new URLSearchParams({ term: `${artist} ${title}`, entity: "song", limit: "1" });
    const response = await fetch(`https://itunes.apple.com/search?${query}`);
    if (!response.ok) return "";
    const data = await response.json();
    const artwork = data.results?.[0]?.artworkUrl100?.replace("100x100bb", "600x600bb") || "";
    artworkCache.set(key, artwork);
    return artwork;
  } catch {
    return "";
  }
}

export function initializeHome({ onPlay, onPlayPlaylist }) {
  async function refreshPlaylists() {
    const playlists = await listPlaylists();
    const list = document.querySelector("#quick-play-list");
    document.querySelector("#quick-play-empty").hidden = playlists.length > 0;
    list.replaceChildren(...playlists.map((playlist) => {
      const item = document.createElement("li");
      const button = document.createElement("button"); button.type = "button"; button.className = "quick-play-card";
      button.setAttribute("aria-label", `Shuffle ${playlist.name}`);
      const image = document.createElement("img"); image.src = playlist.artwork || "/favicon.svg"; image.alt = "";
      image.onerror = () => { image.onerror = null; image.src = "/favicon.svg"; };
      const title = document.createElement("span"); title.textContent = playlist.name;
      button.append(image, title); button.addEventListener("click", () => onPlayPlaylist(playlist)); item.append(button); return item;
    }));
  }
  window.addEventListener("puffin:playlists-updated", () => { refreshPlaylists().catch(() => {}); });
  window.addEventListener("puffin:library-view", () => { refreshPlaylists().catch(() => {}); });
  refreshPlaylists().catch(() => {});
  const recentSection = document.querySelector("#recently-played-section");
  const recentList = document.querySelector("#recently-played-list");
  const recentEmpty = document.querySelector("#recently-played-empty");
  const previous = document.querySelector("#recent-scroll-left");
  const next = document.querySelector("#recent-scroll-right");
  const picksSection = document.querySelector("#music-picks-section");
  const picksList = document.querySelector("#music-picks-list");
  const picksStatus = document.querySelector("#music-picks-status");
  const picksSort = document.querySelector("#music-picks-sort");
  const picksRefresh = document.querySelector("#music-picks-refresh");
  const picksRefreshLabel = document.querySelector("#music-picks-refresh-label");
  const attribution = document.querySelector("#musicatlas-attribution");
  let recommendations = [];
  let picksRequestId = 0;
  let recentRecords = [];

  function updateScrollButtons() {
    const canScroll = !recentList.hidden && recentList.scrollWidth > recentList.clientWidth + 2;
    previous.disabled = !canScroll || recentList.scrollLeft <= 1;
    next.disabled = !canScroll || recentList.scrollLeft + recentList.clientWidth >= recentList.scrollWidth - 2;
  }

  function renderRecentlyPlayed(records) {
    recentRecords = records;
    recentList.replaceChildren();
    records.forEach((record) => {
      const title = record.title || stripExtension(record.name);
      const item = document.createElement("li");
      item.className = "recently-played-item";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "recent-song-button";
      button.setAttribute("aria-label", `Play ${title}`);
      const artwork = document.createElement("img");
      artwork.className = "recent-song-artwork";
      artwork.src = record.artwork || "/favicon.svg";
      artwork.alt = "";
      artwork.loading = "lazy";
      artwork.addEventListener("error", () => {
        if (!artwork.src.endsWith("/favicon.svg")) artwork.src = "/favicon.svg";
      }, { once: true });
      const titleElement = document.createElement("span");
      titleElement.className = "recent-song-title";
      titleElement.textContent = title;
      button.append(artwork, titleElement);
      button.addEventListener("click", () => onPlay(record));
      item.append(button);
      recentList.append(item);
    });
    const hasRecords = records.length > 0;
    recentList.hidden = !hasRecords;
    recentEmpty.hidden = hasRecords;
    recentEmpty.textContent = "Your recently played music will appear here.";
    recentList.scrollLeft = 0;
    requestAnimationFrame(updateScrollButtons);
  }

  function renderRecommendations() {
    const sorted = [...recommendations].sort((a, b) => picksSort.value === "asc" ? a.score - b.score : b.score - a.score);
    picksList.replaceChildren();
    sorted.forEach((track) => {
      const row = document.createElement("li");
      row.className = "music-pick-row";
      const artwork = document.createElement("img");
      artwork.className = "music-pick-artwork";
      artwork.src = track.artwork || "/favicon.svg";
      artwork.alt = "";
      artwork.loading = "lazy";
      artwork.addEventListener("error", () => { if (!artwork.src.endsWith("/favicon.svg")) artwork.src = "/favicon.svg"; }, { once: true });
      const details = document.createElement("div");
      details.className = "music-pick-details";
      const title = document.createElement("strong");
      title.textContent = track.title;
      const artist = document.createElement("span");
      artist.textContent = track.artist;
      details.append(title, artist);
      const download = document.createElement("button");
      download.type = "button";
      download.className = "secondary-button music-pick-download";
      download.textContent = "Find on YouTube";
      download.setAttribute("aria-label", `Find ${track.title} by ${track.artist} to download`);
      download.addEventListener("click", () => {
        document.querySelector('[data-tab="download"]')?.click();
        window.scrollTo(0, 0);
        window.dispatchEvent(new CustomEvent("puffin:download-pick", { detail: { query: `${track.title} ${track.artist}` } }));
      });
      row.append(artwork, details, download);
      picksList.append(row);
    });
    const hasTracks = recommendations.length > 0;
    picksList.hidden = !hasTracks;
    picksStatus.hidden = hasTracks;
    attribution.hidden = !hasTracks;
  }

  function applyPreferences(preferences = getHomePreferences()) {
    recentSection.hidden = !preferences.showRecentlyPlayed;
    picksSection.hidden = !preferences.showMusicPicks;
    if (preferences.showMusicPicks) loadRecommendations(preferences);
    else picksRequestId += 1;
  }

  async function getSimilarTracks(apiKey, seed, force = false) {
    const key = `${apiKey}:${recommendationKey(seed.artist, seed.title)}`;
    const cached = recommendationCache.get(key);
    if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
    const response = await fetch("https://musicatlas.ai/api/similar_tracks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ artist: seed.artist, track: seed.title }),
    });
    if (response.status === 401 || response.status === 403) throw new Error("MusicAtlas rejected this API key. Check it in Settings.");
    if (response.status === 429) throw new Error("MusicAtlas request limit reached. Try again later.");
    if (!response.ok) throw new Error(`MusicAtlas returned ${response.status}.`);
    const data = await response.json();
    const results = Array.isArray(data.matches) ? data.matches : [];
    recommendationCache.set(key, { data: results, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
    return results;
  }

  async function loadRecommendations(preferences = getHomePreferences(), { force = false } = {}) {
    const requestId = ++picksRequestId;
    const apiKey = preferences.musicAtlasApiKey.trim();
    if (!apiKey) {
      recommendations = [];
      renderRecommendations();
      picksStatus.textContent = "Add a MusicAtlas API key in Settings to get music picks.";
      picksRefresh.disabled = false;
      picksRefreshLabel.textContent = "Refresh";
      picksRefresh.removeAttribute("aria-busy");
      picksList.removeAttribute("aria-busy");
      return;
    }

    picksStatus.textContent = "Finding songs similar to your listening…";
    picksRefresh.disabled = true;
    picksRefreshLabel.textContent = "Refreshing…";
    picksRefresh.setAttribute("aria-busy", "true");
    if (force) picksList.setAttribute("aria-busy", "true");
    else {
      recommendations = [];
      renderRecommendations();
    }
    try {
      const [recent, library] = await Promise.all([listRecentlyPlayed(), listMediaFiles()]);
      const seeds = [];
      const seedArtists = new Set();
      for (const record of [...recent, ...library]) {
        const artist = record.artist?.trim();
        const title = record.title?.trim() || stripExtension(record.name).trim();
        if (!artist || !title) continue;
        const artistKey = normalize(artist);
        if (seedArtists.has(artistKey)) continue;
        seedArtists.add(artistKey);
        seeds.push({ artist, title });
        if (seeds.length >= 6) break;
      }
      if (requestId !== picksRequestId) return;
      if (!seeds.length) {
        recommendations = [];
        renderRecommendations();
        picksStatus.textContent = "Add artist tags to your music to get similar song picks.";
        return;
      }

      const inLibrary = new Map();
      for (const record of library) {
        const titleKey = normalize(record.title || stripExtension(record.name));
        const artistSet = inLibrary.get(titleKey) || new Set();
        artistSet.add(normalize(record.artist));
        inLibrary.set(titleKey, artistSet);
      }
      const candidates = new Map();
      let similarResultCount = 0;
      let excludedLibraryCount = 0;
      const addCandidate = (item, score, weight = 1) => {
        const artist = typeof item.artist === "string" ? item.artist : item.artist?.name;
        const title = item.name;
        if (!artist || !title) return;
        similarResultCount += 1;
        const libraryArtists = inLibrary.get(normalize(title));
        if (libraryArtists?.has("") || libraryArtists?.has(normalize(artist))) {
          excludedLibraryCount += 1;
          return;
        }
        const key = recommendationKey(artist, title);
      const candidate = candidates.get(key) || { artist, title, scoreTotal: 0, weightTotal: 0, artwork: "" };
        candidate.scoreTotal += score * weight;
        candidate.weightTotal += weight;
        candidates.set(key, candidate);
      };
      for (let seedIndex = 0; seedIndex < seeds.length; seedIndex += 1) {
        const similar = await getSimilarTracks(apiKey, seeds[seedIndex], force);
        if (requestId !== picksRequestId) return;
        const seedWeight = 1 / (seedIndex + 1);
        similar.forEach((item, index) => addCandidate({ ...item, name: item.title }, 1 / (index + 1), seedWeight));
      }

      const rankedCandidates = [...candidates.values()]
        .map((candidate) => ({ ...candidate, score: candidate.scoreTotal / candidate.weightTotal }))
        .sort((a, b) => b.score - a.score);
      const artistCounts = new Map();
      recommendations = [];
      for (const candidate of rankedCandidates) {
        const artistKey = normalize(candidate.artist);
        const count = artistCounts.get(artistKey) || 0;
        if (count >= 2) continue;
        recommendations.push(candidate);
        artistCounts.set(artistKey, count + 1);
        if (recommendations.length >= 10) break;
      }
      await Promise.all(recommendations.map(async (track) => {
        track.artwork = await recommendationArtwork(track.artist, track.title);
      }));
      if (!recommendations.length) {
        picksStatus.textContent = similarResultCount > 0 && excludedLibraryCount === similarResultCount
          ? "MusicAtlas only returned songs already in your library. Try playing or tagging different tracks."
          : "MusicAtlas didn’t find similar tracks for these songs. Try a better-known track or artist.";
      }
      renderRecommendations();
    } catch (error) {
      if (requestId !== picksRequestId) return;
      picksStatus.textContent = error.message === "Failed to fetch"
        ? "MusicAtlas couldn’t be reached. Check your connection or whether browser access is allowed, then try again."
        : error.message || "Music picks couldn’t be loaded from MusicAtlas.";
      picksStatus.hidden = false;
    } finally {
      if (requestId === picksRequestId) {
        picksRefresh.disabled = false;
        picksRefreshLabel.textContent = "Refresh";
        picksRefresh.removeAttribute("aria-busy");
        picksList.removeAttribute("aria-busy");
      }
    }
  }

  async function refreshRecentlyPlayed() {
    try {
      renderRecentlyPlayed(await listRecentlyPlayed());
    } catch {
      recentList.hidden = true;
      recentEmpty.hidden = false;
      recentEmpty.textContent = "Recently played music couldn’t be loaded.";
      updateScrollButtons();
    }
  }

  previous.addEventListener("click", () => recentList.scrollBy({ left: -recentList.clientWidth * 0.8, behavior: "smooth" }));
  next.addEventListener("click", () => recentList.scrollBy({ left: recentList.clientWidth * 0.8, behavior: "smooth" }));
  recentList.addEventListener("scroll", updateScrollButtons, { passive: true });
  picksSort.addEventListener("change", renderRecommendations);
  picksRefresh.addEventListener("click", () => {
    recommendationCache.clear();
    loadRecommendations(undefined, { force: true });
  });
  window.addEventListener("resize", updateScrollButtons);
  window.addEventListener("puffin:recently-played-updated", () => {
    refreshRecentlyPlayed();
    applyPreferences();
  });
  window.addEventListener("puffin:metadata-updated", () => {
    refreshRecentlyPlayed();
    applyPreferences();
  });
  window.addEventListener("puffin:library-updated", () => {
    refreshRecentlyPlayed();
    applyPreferences();
  });
  window.addEventListener("puffin:home-preferences-updated", (event) => applyPreferences(event.detail));
  refreshRecentlyPlayed();
  applyPreferences();
}
