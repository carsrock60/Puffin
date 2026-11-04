import { getMediaBlob, getVideoWatchHistory, listMediaFiles, listPlaylists } from "./library.js";

const titleOf = (record) => record.title || record.name.replace(/\.[^.]+$/, "");
const normalize = (value) => String(value || "").toLocaleLowerCase().trim();

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function initializeWatch({ onPlay }) {
  const featured = document.querySelector("#watch-featured");
  const featuredSection = document.querySelector("#watch-featured-section");
  const continueList = document.querySelector("#watch-continue-list");
  const continueEmpty = document.querySelector("#watch-continue-empty");
  const recentList = document.querySelector("#watch-recent-list");
  const recentEmpty = document.querySelector("#watch-recent-empty");
  const libraryList = document.querySelector("#watch-video-library");
  const libraryEmpty = document.querySelector("#watch-library-empty");
  const searchInput = document.querySelector("#watch-search");
  const filterSelect = document.querySelector("#watch-filter");
  const playlistSelect = document.querySelector("#watch-playlist-filter");

  let videos = [];
  let playlists = [];
  let history = [];
  let progressById = new Map();
  let recentIds = new Set();
  let renderRequest = 0;
  const durationCache = new Map();
  const durationTargets = new Map();

  async function loadDuration(record, target) {
    if (durationCache.has(record.id)) {
      if (target.isConnected) target.textContent = durationCache.get(record.id);
      return;
    }
    try {
      const blob = await getMediaBlob(record.id);
      if (!blob) return;
      const element = document.createElement("video");
      const objectUrl = URL.createObjectURL(blob);
      element.preload = "metadata";
      element.onloadedmetadata = () => {
        const duration = formatTime(element.duration);
        if (duration) {
          durationCache.set(record.id, duration);
          if (target.isConnected) target.textContent = [record.artist, duration, new Date(record.importedAt).toLocaleDateString()].filter(Boolean).join(" · ");
        }
        URL.revokeObjectURL(objectUrl);
        element.removeAttribute("src");
        element.load();
      };
      element.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        element.removeAttribute("src");
      };
      element.src = objectUrl;
    } catch {
      // The video remains playable even when its metadata cannot be read.
    }
  }

  const durationObserver = "IntersectionObserver" in window
    ? new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        durationObserver.unobserve(entry.target);
        const target = durationTargets.get(entry.target);
        durationTargets.delete(entry.target);
        if (target) loadDuration(target.record, target.metadata);
      });
    }, { rootMargin: "200px" })
    : null;

  function makeThumbnail(record, className = "watch-thumbnail") {
    const wrapper = document.createElement("div");
    wrapper.className = className;
    wrapper.setAttribute("aria-hidden", "true");
    wrapper.style.setProperty("--thumbnail-seed", String([...titleOf(record)].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 360));
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    if (record.artwork) {
      image.src = record.artwork;
      image.addEventListener("error", () => {
        image.remove();
        wrapper.classList.add("has-fallback");
      }, { once: true });
      wrapper.append(image);
    } else {
      wrapper.classList.add("has-fallback");
    }
    const playMark = document.createElement("span");
    playMark.className = "watch-thumbnail-mark";
    playMark.textContent = "▶";
    wrapper.append(playMark);
    return wrapper;
  }

  function addProgressMark(wrapper, progress) {
    if (!progress || progress.duration <= 0 || progress.completed) return;
    const bar = document.createElement("span");
    bar.className = "watch-progress-track";
    bar.setAttribute("aria-hidden", "true");
    const fill = document.createElement("span");
    fill.style.width = `${Math.max(2, Math.min(100, progress.currentTime / progress.duration * 100))}%`;
    bar.append(fill);
    wrapper.append(bar);
  }

  function createVideoCard(record, { progress = progressById.get(record.id), compact = false } = {}) {
    const card = document.createElement("article");
    card.className = compact ? "watch-video-card watch-video-card-compact" : "watch-video-card";
    card.setAttribute("role", "listitem");
    const playButton = document.createElement("button");
    playButton.type = "button";
    playButton.className = "watch-thumbnail-button";
    playButton.setAttribute("aria-label", `Play ${titleOf(record)}`);
    const thumbnail = makeThumbnail(record);
    if (!compact) thumbnail.classList.add("watch-library-thumbnail");
    addProgressMark(thumbnail, progress);
    playButton.append(thumbnail);
    playButton.addEventListener("click", () => onPlay(record, progress && !progress.completed ? progress.currentTime : 0));
    const title = document.createElement("h3");
    title.textContent = titleOf(record);
    const metadata = document.createElement("p");
    metadata.className = "watch-video-metadata";
    const knownDuration = durationCache.get(record.id) || formatTime(progress?.duration || record.duration);
    const details = [record.artist, knownDuration, new Date(record.importedAt).toLocaleDateString()]
      .filter(Boolean);
    metadata.textContent = details.join(" · ") || "Video";
    if (!knownDuration) {
      if (durationObserver) {
        durationTargets.set(thumbnail, { record, metadata });
        durationObserver.observe(thumbnail);
      } else loadDuration(record, metadata);
    }
    const textButton = document.createElement("button");
    textButton.type = "button";
    textButton.className = "watch-video-title-button";
    textButton.setAttribute("aria-label", `Play ${titleOf(record)}`);
    textButton.append(title);
    textButton.addEventListener("click", () => onPlay(record, progress && !progress.completed ? progress.currentTime : 0));
    card.append(playButton, textButton, metadata);
    return card;
  }

  function renderFeatured() {
    featured.replaceChildren();
    const candidate = [...history]
      .sort((first, second) => second.watchedAt - first.watchedAt)
      .map((item) => videos.find((video) => video.id === item.mediaId))
      .find(Boolean) || videos[0];
    if (!candidate) {
      const empty = document.createElement("div");
      empty.className = "watch-featured-empty";
      const copy = document.createElement("div");
      const eyebrow = document.createElement("p");
      eyebrow.className = "watch-eyebrow";
      eyebrow.textContent = "YOUR PERSONAL VIDEO LIBRARY";
      const heading = document.createElement("h2");
      heading.textContent = "Make room for movie night.";
      const message = document.createElement("p");
      message.textContent = "Videos you import into Puffin will be ready to watch here.";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary-button";
      button.textContent = "Open your library";
      button.addEventListener("click", () => document.querySelector('[data-library-view="library"]')?.click());
      copy.append(eyebrow, heading, message, button);
      const art = document.createElement("div");
      art.className = "watch-featured-art watch-featured-art-empty";
      const artMark = document.createElement("span");
      artMark.setAttribute("aria-hidden", "true");
      artMark.textContent = "▶";
      art.append(artMark);
      empty.append(copy, art);
      featured.append(empty);
      return;
    }

    const hero = document.createElement("article");
    hero.className = "watch-featured-card";
    const art = makeThumbnail(candidate, "watch-featured-art");
    const copy = document.createElement("div");
    copy.className = "watch-featured-copy";
    const eyebrow = document.createElement("p");
    eyebrow.className = "watch-eyebrow";
    const candidateProgress = progressById.get(candidate.id);
    const canContinue = candidateProgress && !candidateProgress.completed && candidateProgress.currentTime > 1;
    eyebrow.textContent = canContinue ? "PICK UP WHERE YOU LEFT OFF" : "FEATURED VIDEO";
    const heading = document.createElement("h2");
    heading.textContent = titleOf(candidate);
    const metadata = document.createElement("p");
    metadata.className = "watch-featured-metadata";
    metadata.textContent = [candidate.artist, formatTime(candidateProgress?.duration || candidate.duration)]
      .filter(Boolean).join(" · ");
    const play = document.createElement("button");
    play.type = "button";
    play.className = "primary-button watch-featured-play";
    play.textContent = canContinue ? "Continue watching" : "Play video";
    play.addEventListener("click", () => {
      onPlay(candidate, canContinue ? candidateProgress.currentTime : 0);
    });
    copy.append(eyebrow, heading, metadata, play);
    hero.append(art, copy);
    featured.append(hero);
  }

  function renderShortRows() {
    for (const [target] of durationTargets) {
      if (target.closest(".watch-card-row")) {
        durationObserver?.unobserve(target);
        durationTargets.delete(target);
      }
    }
    const continueVideos = [...history]
      .filter((item) => !item.completed && item.currentTime > 1)
      .sort((first, second) => second.watchedAt - first.watchedAt)
      .map((item) => videos.find((video) => video.id === item.mediaId))
      .filter(Boolean)
      .slice(0, 12);
    continueList.replaceChildren(...continueVideos.map((record) => createVideoCard(record, { compact: true })));
    continueEmpty.hidden = continueVideos.length > 0;

    const recentVideos = [...history]
      .sort((first, second) => second.watchedAt - first.watchedAt)
      .map((item) => videos.find((video) => video.id === item.mediaId))
      .filter((record, index, list) => record && list.findIndex((candidate) => candidate.id === record.id) === index)
      .slice(0, 12);
    recentIds = new Set(recentVideos.map((record) => record.id));
    recentList.replaceChildren(...recentVideos.map((record) => createVideoCard(record, { compact: true })));
    recentEmpty.hidden = recentVideos.length > 0;
  }

  function renderLibrary() {
    for (const [target] of durationTargets) {
      if (target.classList.contains("watch-library-thumbnail")) {
        durationObserver?.unobserve(target);
        durationTargets.delete(target);
      }
    }
    const query = normalize(searchInput.value);
    const selectedPlaylist = playlistSelect.value;
    const playlist = playlists.find((item) => item.id === selectedPlaylist);
    const playlistIds = playlist ? new Set(playlist.mediaIds) : null;
    let filtered = videos.filter((record) => {
      if (playlistIds && !playlistIds.has(record.id)) return false;
      const searchable = normalize([titleOf(record), record.name, record.artist, record.album, record.genre].join(" "));
      if (query && !searchable.includes(query)) return false;
      if (filterSelect.value === "continue") {
        const progress = progressById.get(record.id);
        return Boolean(progress && !progress.completed && progress.currentTime > 1);
      }
      if (filterSelect.value === "recent") return recentIds.has(record.id);
      return true;
    });
    filtered = filtered.sort((first, second) => second.importedAt - first.importedAt);
    libraryList.replaceChildren(...filtered.map((record) => createVideoCard(record)));
    libraryEmpty.hidden = filtered.length > 0;
  }

  function renderPlaylistOptions() {
    const previousValue = playlistSelect.value;
    playlistSelect.replaceChildren(new Option("All playlists", "all"));
    playlists.forEach((playlist) => playlistSelect.add(new Option(playlist.name, playlist.id)));
    playlistSelect.value = playlists.some((playlist) => playlist.id === previousValue) ? previousValue : "all";
  }

  async function render() {
    const request = ++renderRequest;
    try {
      const [records, nextPlaylists, nextHistory] = await Promise.all([
        listMediaFiles(), listPlaylists(), getVideoWatchHistory(),
      ]);
      if (request !== renderRequest) return;
      videos = records.filter((record) => record.kind === "video");
      playlists = nextPlaylists;
      history = nextHistory.filter((item) => videos.some((record) => record.id === item.mediaId));
      progressById = new Map(history.map((item) => [item.mediaId, item]));
      renderPlaylistOptions();
      renderFeatured();
      renderShortRows();
      renderLibrary();
      featuredSection.hidden = false;
    } catch (error) {
      featured.replaceChildren();
      const message = document.createElement("p");
      message.className = "watch-empty";
      message.textContent = `Could not load videos: ${error.message}`;
      featured.append(message);
    }
  }

  searchInput.addEventListener("input", renderLibrary);
  filterSelect.addEventListener("change", renderLibrary);
  playlistSelect.addEventListener("change", renderLibrary);
  window.addEventListener("puffin:library-updated", render);
  window.addEventListener("puffin:metadata-updated", render);
  window.addEventListener("puffin:video-progress-updated", render);
  window.addEventListener("puffin:tab-changed", (event) => {
    if (event.detail === "watch") render();
  });
  render();
}
