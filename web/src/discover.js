import { getPuffinStats, listMediaFiles, listRecentlyPlayed } from "./library.js";
import {
  buildDiscoveryProfile,
  DISCOVERY_CACHE_KEY,
  DISCOVERY_SEEN_KEY,
  discoverySeedContext,
  isDiscoveryCacheFresh,
  isDiscoveryCacheUsable,
  mergeSeenArtists,
  normalizeDiscoveryName,
} from "./discover-engine.js";

const RECOMMENDATION_LIMIT = 16;
const FEATURED_LIMIT = 8;
const REQUEST_TIMEOUT = 22000;

function isSafeImageUrl(value) {
  try {
    return new URL(String(value || ""), window.location.href).protocol === "https:";
  } catch {
    return false;
  }
}

function hashSeed(value) {
  let hash = 0;
  const text = String(value || "Puffin");
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) % 360;
  return hash;
}

function initials(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "♪";
  if (words.length === 1) return words[0].slice(0, 2).toLocaleUpperCase();
  return `${words[0][0]}${words[words.length - 1][0]}`.toLocaleUpperCase();
}

function createPlaceholder(name, className = "") {
  const placeholder = document.createElement("div");
  placeholder.className = `discover-placeholder ${className}`.trim();
  placeholder.setAttribute("aria-hidden", "true");
  placeholder.style.setProperty("--discover-seed", String(hashSeed(name)));
  placeholder.textContent = initials(name);
  return placeholder;
}

function setArtwork(container, source, { name, alt, className = "" }) {
  container.replaceChildren();
  if (!isSafeImageUrl(source)) {
    container.append(createPlaceholder(name, className));
    return;
  }
  const image = document.createElement("img");
  image.className = className;
  image.src = source;
  image.alt = alt;
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("error", () => {
    if (image.isConnected) image.replaceWith(createPlaceholder(name, className));
  }, { once: true });
  container.append(image);
}

function timeAgo(value) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return "";
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function readCache() {
  try {
    const value = JSON.parse(localStorage.getItem(DISCOVERY_CACHE_KEY) || "null");
    if (!value || typeof value !== "object") return null;
    return value;
  } catch {
    return null;
  }
}

function writeCache(profile, payload) {
  if (!payload?.recommendations?.length) return;
  try {
    localStorage.setItem(DISCOVERY_CACHE_KEY, JSON.stringify({
      savedAt: Date.now(),
      profileSignature: profile.signature,
      payload,
    }));
  } catch { /* Discover keeps working without a local cache. */ }
}

function readSeen() {
  try {
    const value = JSON.parse(localStorage.getItem(DISCOVERY_SEEN_KEY) || "[]");
    return Array.isArray(value) ? value.filter((name) => typeof name === "string") : [];
  } catch {
    return [];
  }
}

function writeSeen(names) {
  try {
    localStorage.setItem(DISCOVERY_SEEN_KEY, JSON.stringify(names));
  } catch { /* Seen-artist memory is optional. */ }
}

function reactionMessage(error) {
  if (error?.name === "AbortError") return "Discovery took too long to respond. Try again.";
  if (error instanceof TypeError) return "Puffin couldn’t reach the discovery service. Check your connection and try again.";
  return error?.message || "Puffin couldn’t refresh your recommendations.";
}

export function initializeDiscover({ onFindMusic, onOpenLibrary, onSearchLibrary } = {}) {
  const panel = document.querySelector("#discover-panel");
  if (!panel) return;
  const recommendationsSection = document.querySelector("#discover-recommendations-section");
  const recommendationsGrid = document.querySelector("#discover-recommendations");
  const skeleton = document.querySelector("#discover-skeleton");
  const exploreSection = document.querySelector("#discover-explore-section");
  const exploreGrid = document.querySelector("#discover-explore");
  const albumsSection = document.querySelector("#discover-albums-section");
  const albumsGrid = document.querySelector("#discover-albums");
  const status = document.querySelector("#discover-status");
  const statusTitle = document.querySelector("#discover-status-title");
  const statusMessage = document.querySelector("#discover-status-message");
  const statusAction = document.querySelector("#discover-status-action");
  const context = document.querySelector("#discover-context");
  const updated = document.querySelector("#discover-updated");
  const refresh = document.querySelector("#discover-refresh");
  const refreshLabel = document.querySelector("#discover-refresh-label");
  const footer = document.querySelector("#discover-footer");
  const dialog = document.querySelector("#discover-artist-dialog");
  const dialogClose = document.querySelector("#discover-dialog-close");
  const dialogHero = document.querySelector("#discover-dialog-hero");
  const dialogArt = document.querySelector("#discover-dialog-art");
  const dialogTitle = document.querySelector("#discover-dialog-title");
  const dialogKicker = document.querySelector("#discover-dialog-kicker");
  const dialogTags = document.querySelector("#discover-dialog-tags");
  const dialogBio = document.querySelector("#discover-dialog-bio");
  const dialogStatus = document.querySelector("#discover-dialog-status");
  const dialogAlbumsSection = document.querySelector("#discover-dialog-albums-section");
  const dialogAlbums = document.querySelector("#discover-dialog-albums");
  const dialogTracksSection = document.querySelector("#discover-dialog-tracks-section");
  const dialogTracks = document.querySelector("#discover-dialog-tracks");
  const dialogCredit = document.querySelector("#discover-dialog-credit");
  const dialogFind = document.querySelector("#discover-dialog-find");
  const dialogLibrary = document.querySelector("#discover-dialog-library");
  const dialogSearch = document.querySelector("#discover-dialog-search");

  let currentProfile = null;
  let currentPayload = null;
  let currentRecommendations = [];
  let exploreArtists = [];
  let loading = false;
  let hasLoaded = false;
  let profileDirty = false;
  let requestToken = 0;
  let dirtyTimer = 0;
  let statusActionHandler = null;
  let pendingReload = false;
  let activeArtist = null;
  let activeDetailController = null;
  let dialogToken = 0;
  const detailCache = new Map();

  statusAction.addEventListener("click", () => {
    const handler = statusActionHandler;
    statusActionHandler = null;
    handler?.();
  });

  function buildSkeleton() {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 8; index += 1) {
      const card = document.createElement("div");
      card.className = "discover-skeleton-card";
      card.setAttribute("aria-hidden", "true");
      const art = document.createElement("div");
      art.className = "discover-skeleton-art";
      const line = document.createElement("div");
      line.className = "discover-skeleton-line";
      const shortLine = document.createElement("div");
      shortLine.className = "discover-skeleton-line is-short";
      card.append(art, line, shortLine);
      fragment.append(card);
    }
    skeleton.replaceChildren(fragment);
  }
  buildSkeleton();

  function setStatus({ title, message, actionLabel = "", onAction = null, inline = false }) {
    status.hidden = false;
    status.classList.toggle("is-inline", inline);
    statusTitle.textContent = title;
    statusMessage.textContent = message;
    statusAction.hidden = !actionLabel;
    statusAction.textContent = actionLabel;
    statusActionHandler = onAction;
  }

  function clearStatus() {
    status.hidden = true;
    status.classList.remove("is-inline");
    statusActionHandler = null;
  }

  function showSkeleton() {
    panel.classList.remove("is-empty");
    recommendationsSection.hidden = false;
    recommendationsGrid.hidden = true;
    skeleton.hidden = false;
    recommendationsSection.setAttribute("aria-busy", "true");
    exploreSection.hidden = true;
    albumsSection.hidden = true;
    footer.hidden = false;
    clearStatus();
    updated.textContent = "Finding your next favorites…";
    context.hidden = true;
  }

  function showBlockingState({ title, message, actionLabel = "", onAction = null }) {
    panel.classList.add("is-empty");
    recommendationsSection.hidden = true;
    recommendationsSection.removeAttribute("aria-busy");
    skeleton.hidden = true;
    exploreSection.hidden = true;
    albumsSection.hidden = true;
    recommendationsGrid.replaceChildren();
    exploreGrid.replaceChildren();
    albumsGrid.replaceChildren();
    context.hidden = true;
    updated.textContent = "";
    footer.hidden = false;
    setStatus({ title, message, actionLabel, onAction });
  }

  function setRefreshing(isRefreshing) {
    refresh.disabled = isRefreshing;
    refreshLabel.textContent = isRefreshing ? "Refreshing…" : "Refresh";
    refresh.setAttribute("aria-busy", String(isRefreshing));
    if (isRefreshing) panel.setAttribute("aria-busy", "true");
    else panel.removeAttribute("aria-busy");
  }

  async function getProfile() {
    const records = await listMediaFiles();
    const [stats, recent] = await Promise.all([
      getPuffinStats().catch(() => ({ days: {} })),
      listRecentlyPlayed().catch(() => []),
    ]);
    return buildDiscoveryProfile(records, stats, recent);
  }

  async function requestRecommendations(profile, { refresh: forceRefresh = false } = {}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const response = await fetch("/api/discover/recommendations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artists: profile.seeds,
          known_artists: profile.knownArtists,
          seen_artists: readSeen(),
          limit: RECOMMENDATION_LIMIT,
          refresh: Boolean(forceRefresh),
        }),
        signal: controller.signal,
      });
      let payload = null;
      try { payload = await response.json(); } catch { /* The error below explains it. */ }
      if (!response.ok) {
        const error = new Error(payload?.message || `Discovery returned ${response.status}.`);
        error.retryable = payload?.retryable !== false;
        throw error;
      }
      if (!payload || typeof payload.status !== "string") throw new Error("Discovery returned an unreadable response.");
      return payload;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function createArtistCard(artist, index) {
    const name = String(artist?.name || "").trim();
    const card = document.createElement("article");
    card.className = "discover-artist-card";
    card.setAttribute("role", "listitem");
    card.style.setProperty("--discover-delay", `${Math.min(index * 45, 315)}ms`);

    const media = document.createElement("button");
    media.type = "button";
    media.className = "discover-artist-media";
    media.setAttribute("aria-label", `Explore ${name}`);
    media.style.setProperty("--discover-seed", String(hashSeed(name)));
    media.addEventListener("click", () => openArtist(artist));
    setArtwork(media, artist.image, { name, alt: `${name} artist photo`, className: "discover-artist-photo" });
    const number = document.createElement("span");
    number.className = "discover-card-index";
    number.textContent = String(index + 1).padStart(2, "0");
    media.append(number);

    const body = document.createElement("div");
    body.className = "discover-artist-body";
    const reason = document.createElement("p");
    reason.className = "discover-card-reason";
    reason.textContent = artist.reason || "Picked for you";
    const heading = document.createElement("h3");
    const nameButton = document.createElement("button");
    nameButton.type = "button";
    nameButton.className = "discover-artist-name";
    nameButton.textContent = name;
    nameButton.addEventListener("click", () => openArtist(artist));
    heading.append(nameButton);
    const tags = document.createElement("div");
    tags.className = "discover-tags";
    for (const tag of (Array.isArray(artist.tags) ? artist.tags : []).slice(0, 3)) {
      const chip = document.createElement("span");
      chip.textContent = String(tag);
      tags.append(chip);
    }
    if (!tags.childElementCount) {
      const chip = document.createElement("span");
      chip.textContent = "New to you";
      tags.append(chip);
    }
    const actions = document.createElement("div");
    actions.className = "discover-card-actions";
    const find = document.createElement("button");
    find.type = "button";
    find.className = "discover-card-find";
    find.textContent = "Find music";
    find.setAttribute("aria-label", `Find music by ${name} on YouTube`);
    find.addEventListener("click", () => onFindMusic?.(name));
    const more = document.createElement("button");
    more.type = "button";
    more.className = "discover-card-more";
    more.textContent = "Details";
    more.addEventListener("click", () => openArtist(artist));
    actions.append(find, more);
    body.append(reason, heading, tags, actions);
    card.append(media, body);
    return card;
  }

  function createExploreCard(artist, index) {
    const name = String(artist?.name || "").trim();
    const card = document.createElement("article");
    card.className = "discover-explore-card";
    card.setAttribute("role", "listitem");
    card.style.setProperty("--discover-delay", `${Math.min(index * 35, 245)}ms`);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "discover-explore-button";
    button.setAttribute("aria-label", `Explore ${name}`);
    button.addEventListener("click", () => openArtist(artist));
    const media = document.createElement("span");
    media.className = "discover-explore-media";
    media.style.setProperty("--discover-seed", String(hashSeed(name)));
    setArtwork(media, artist.image, { name, alt: `${name} artist photo`, className: "discover-explore-photo" });
    const label = document.createElement("strong");
    label.textContent = name;
    const tag = document.createElement("span");
    tag.className = "discover-explore-tag";
    tag.textContent = String(artist.tags?.[0] || "Artist");
    button.append(media, label, tag);
    card.append(button);
    return card;
  }

  function createAlbumCard(album) {
    const title = String(album?.title || "").trim();
    const artist = String(album?.artist || "").trim();
    const card = document.createElement("article");
    card.className = "discover-album-card";
    card.setAttribute("role", "listitem");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "discover-album-button";
    button.setAttribute("aria-label", `Explore ${title} by ${artist}`);
    button.addEventListener("click", () => {
      const known = [...currentRecommendations, ...exploreArtists].find((item) => normalizeDiscoveryName(item.name) === normalizeDiscoveryName(artist));
      openArtist(known || { name: artist, tags: [], albums: [] });
    });
    const art = document.createElement("span");
    art.className = "discover-album-art";
    art.style.setProperty("--discover-seed", String(hashSeed(`${artist} ${title}`)));
    setArtwork(art, album.artwork, { name: title, alt: `${title} album cover`, className: "discover-album-cover" });
    const copy = document.createElement("span");
    copy.className = "discover-album-copy";
    const name = document.createElement("strong");
    name.textContent = title;
    const byline = document.createElement("span");
    byline.textContent = [artist, album.year].filter(Boolean).join(" · ");
    copy.append(name, byline);
    button.append(art, copy);
    card.append(button);
    return card;
  }

  function renderAlbumGrid(container, albums) {
    container.replaceChildren(...(Array.isArray(albums) ? albums : []).filter((album) => album?.title && album?.artist).slice(0, 10).map(createAlbumCard));
    return container.childElementCount > 0;
  }

  function renderPayload(payload, { stale = false, offline = false } = {}) {
    const seenNames = new Set();
    const recommendations = (Array.isArray(payload?.recommendations) ? payload.recommendations : [])
      .filter((artist) => artist?.name)
      .filter((artist) => {
        const key = normalizeDiscoveryName(artist.name);
        if (!key || seenNames.has(key)) return false;
        seenNames.add(key);
        return true;
      });
    if (!recommendations.length) return false;
    currentPayload = payload;
    currentRecommendations = recommendations.slice(0, FEATURED_LIMIT);
    exploreArtists = recommendations.slice(FEATURED_LIMIT, RECOMMENDATION_LIMIT);
    panel.classList.remove("is-empty");
    clearStatus();
    if (stale || offline) {
      setStatus({
        title: offline ? "Showing your saved mix" : "Your saved mix is still fresh",
        message: offline
          ? "You’re offline, so Puffin is showing the last recommendations it saved on this device."
          : "Puffin couldn’t refresh just now, so your last recommendations are still here.",
        actionLabel: offline ? "" : "Try again",
        onAction: offline ? null : () => load({ force: true, manual: true }),
        inline: true,
      });
    }
    recommendationsGrid.replaceChildren(...currentRecommendations.map(createArtistCard));
    recommendationsGrid.hidden = false;
    skeleton.hidden = true;
    recommendationsSection.hidden = false;
    recommendationsSection.removeAttribute("aria-busy");
    exploreGrid.replaceChildren(...exploreArtists.map(createExploreCard));
    exploreSection.hidden = exploreGrid.childElementCount === 0;
    const hasAlbums = renderAlbumGrid(albumsGrid, payload.albums);
    albumsSection.hidden = !hasAlbums;
    footer.hidden = false;
    const seedContext = discoverySeedContext(currentProfile);
    context.textContent = currentProfile?.hasListeningHistory
      ? seedContext
      : "Built from the artists in your library. Play a few tracks to make it even more personal.";
    context.hidden = !context.textContent;
    const when = timeAgo(payload.generatedAt);
    updated.textContent = when ? `${stale ? "Saved mix" : "Updated"} ${when}` : "";
    return true;
  }

  function renderDialogAlbums(albums, artistName) {
    dialogAlbums.replaceChildren();
    for (const album of (Array.isArray(albums) ? albums : []).slice(0, 6)) {
      const card = createAlbumCard({ ...album, artist: album.artist || artistName });
      dialogAlbums.append(card);
    }
    dialogAlbumsSection.hidden = dialogAlbums.childElementCount === 0;
  }

  function renderDialogTracks(tracks, artistName) {
    dialogTracks.replaceChildren();
    const seenTitles = new Set();
    const unique = (Array.isArray(tracks) ? tracks : []).filter((track) => {
      const key = normalizeDiscoveryName(track?.title);
      if (!key || seenTitles.has(key)) return false;
      seenTitles.add(key);
      return true;
    });
    for (const [index, track] of unique.slice(0, 5).entries()) {
      const item = document.createElement("li");
      const order = document.createElement("span");
      order.className = "discover-track-index";
      order.textContent = String(index + 1).padStart(2, "0");
      const title = document.createElement("strong");
      title.textContent = String(track.title || "");
      const find = document.createElement("button");
      find.type = "button";
      find.className = "discover-track-find";
      find.textContent = "Find";
      find.setAttribute("aria-label", `Find ${track.title} by ${artistName}`);
      find.addEventListener("click", () => {
        closeDialog();
        onFindMusic?.(`${track.title} ${artistName}`);
      });
      item.append(order, title, find);
      dialogTracks.append(item);
    }
    dialogTracksSection.hidden = dialogTracks.childElementCount === 0;
  }

  function applyDialogData(artist, detail = null) {
    const name = String(detail?.name || artist?.name || "Artist").trim();
    dialogTitle.textContent = name;
    dialogHero.style.setProperty("--discover-seed", String(hashSeed(name)));
    const tags = Array.isArray(detail?.tags) && detail.tags.length ? detail.tags : (artist?.tags || []);
    dialogTags.replaceChildren(...tags.slice(0, 5).map((tag) => {
      const chip = document.createElement("span");
      chip.textContent = String(tag);
      return chip;
    }));
    dialogTags.hidden = dialogTags.childElementCount === 0;
    const image = detail?.image || artist?.image || "";
    setArtwork(dialogArt, image, { name, alt: `${name} artist photo`, className: "discover-dialog-photo" });
    const bio = String(detail?.bio || "").trim();
    dialogBio.textContent = bio;
    dialogBio.hidden = !bio;
    renderDialogAlbums(detail?.albums || artist?.albums, name);
    renderDialogTracks(detail?.topTracks, name);
    const source = detail?.imageSource || artist?.imageSource;
    dialogCredit.textContent = source ? `Artist photo from ${source}.` : "Artist photo unavailable.";
    dialogCredit.hidden = false;
    dialogKicker.textContent = detail?.mbid ? "ARTIST PROFILE" : "FROM YOUR DISCOVERY";
  }

  function detailKey(artist) {
    return `${normalizeDiscoveryName(artist?.name)}:${artist?.mbid || ""}`;
  }

  async function loadDialogDetail(artist, token) {
    const key = detailKey(artist);
    const cached = detailCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      applyDialogData(artist, cached.artist);
      dialogStatus.hidden = true;
      return;
    }
    activeDetailController?.abort();
    const controller = new AbortController();
    activeDetailController = controller;
    dialogStatus.hidden = false;
    dialogStatus.textContent = "Loading artist details…";
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const params = new URLSearchParams({ name: String(artist.name || "") });
      if (artist.mbid) params.set("mbid", String(artist.mbid));
      const response = await fetch(`/api/discover/artist?${params}`, { signal: controller.signal });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.message || `Artist details returned ${response.status}.`);
      if (!data?.artist) throw new Error("Artist details were unavailable.");
      if (token !== dialogToken) return;
      detailCache.set(key, { artist: data.artist, expiresAt: Date.now() + 30 * 60_000 });
      applyDialogData(artist, data.artist);
      dialogStatus.hidden = true;
    } catch (error) {
      if (token !== dialogToken) return;
      dialogStatus.hidden = false;
      dialogStatus.textContent = error.name === "AbortError" ? "Artist details took too long to load." : "More artist details are unavailable right now.";
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function openArtist(artist) {
    if (!artist?.name) return;
    activeArtist = artist;
    dialogToken += 1;
    const token = dialogToken;
    dialogStatus.hidden = true;
    applyDialogData(artist);
    if (!dialog.open) dialog.showModal();
    dialogClose.focus({ preventScroll: true });
    loadDialogDetail(artist, token);
  }

  function closeDialog() {
    dialogToken += 1;
    activeDetailController?.abort();
    activeDetailController = null;
    if (dialog.open) dialog.close();
  }

  async function load({ force = false, manual = false } = {}) {
    if (loading) return;
    loading = true;
    const token = ++requestToken;
    setRefreshing(true);
    let cachedShown = false;
    try {
      const profile = await getProfile();
      if (token !== requestToken) return;
      currentProfile = profile;
      if (!profile.hasLibrary) {
        currentPayload = null;
        showBlockingState({
          title: "Your library is waiting",
          message: "Import a few songs and Discover will start learning what you love. No setup or API keys needed.",
          actionLabel: "Open library",
          onAction: () => onOpenLibrary?.(),
        });
        hasLoaded = true;
        profileDirty = false;
        return;
      }
      if (!profile.seeds.length) {
        currentPayload = null;
        showBlockingState({
          title: "Add a little more detail",
          message: "Puffin needs artist names to build your mix. Edit a few tracks or albums to add them, then come back.",
          actionLabel: "Open library",
          onAction: () => onOpenLibrary?.(),
        });
        hasLoaded = true;
        profileDirty = false;
        return;
      }
      const cache = readCache();
      if (!force && isDiscoveryCacheFresh(cache, profile)) {
        renderPayload(cache.payload);
        hasLoaded = true;
        profileDirty = false;
        return;
      }
      if (isDiscoveryCacheUsable(cache)) {
        renderPayload(cache.payload, { stale: true, offline: !navigator.onLine });
        cachedShown = true;
        hasLoaded = true;
      } else {
        showSkeleton();
      }
      if (!navigator.onLine) {
        if (!cachedShown) {
          showBlockingState({
            title: "You’re offline",
            message: "Connect to the internet and Puffin will find new artists for you.",
            actionLabel: "Try again",
            onAction: () => load({ force: true, manual: true }),
          });
        }
        hasLoaded = true;
        return;
      }
      const payload = await requestRecommendations(profile, { refresh: force || manual });
      if (token !== requestToken) return;
      if (payload.status === "unconfigured") {
        if (cachedShown) {
          setStatus({
            title: "Showing your saved mix",
            message: "Discovery isn’t configured on this server yet, so your last recommendations are still here.",
            inline: true,
          });
          hasLoaded = true;
          return;
        }
        currentPayload = null;
        showBlockingState({
          title: "Discovery is almost ready",
          message: "The Puffin host needs to finish connecting the music catalog. Your library is safe and sound.",
        });
        hasLoaded = true;
        profileDirty = false;
        return;
      }
      const hasRecommendations = Boolean(renderPayload(payload));
      if (!hasRecommendations) {
        if (cachedShown) {
          setStatus({
            title: "No fresh picks just yet",
            message: payload.message || "Puffin couldn’t find new artists right now. Your saved mix is still here.",
            actionLabel: "Try again",
            onAction: () => load({ force: true, manual: true }),
            inline: true,
          });
          hasLoaded = true;
          return;
        }
        showBlockingState({
          title: "No new artists just yet",
          message: payload.message || "Puffin couldn’t find new artists for you right now. Try again in a little while.",
          actionLabel: "Try again",
          onAction: () => load({ force: true, manual: true }),
        });
        hasLoaded = true;
        profileDirty = false;
        return;
      }
      currentPayload = payload;
      writeCache(profile, payload);
      writeSeen(mergeSeenArtists(readSeen(), payload.recommendations));
      hasLoaded = true;
      profileDirty = false;
    } catch (error) {
      if (token !== requestToken) return;
      hasLoaded = true;
      const canRetry = error?.retryable !== false;
      if (cachedShown) {
        setStatus({
          title: "Showing your saved mix",
          message: reactionMessage(error),
          actionLabel: canRetry ? "Try again" : "",
          onAction: canRetry ? () => load({ force: true, manual: true }) : null,
          inline: true,
        });
      } else {
        showBlockingState({
          title: "Discover couldn’t refresh",
          message: reactionMessage(error),
          actionLabel: canRetry ? "Try again" : "",
          onAction: canRetry ? () => load({ force: true, manual: true }) : null,
        });
      }
    } finally {
      if (token === requestToken) {
        loading = false;
        setRefreshing(false);
        if (pendingReload && !panel.hidden) {
          pendingReload = false;
          load();
        }
      }
    }
  }

  refresh.addEventListener("click", () => load({ force: true, manual: true }));
  dialogClose.addEventListener("click", closeDialog);
  dialog.addEventListener("click", (event) => { if (event.target === dialog) closeDialog(); });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeDialog(); });
  dialogFind.addEventListener("click", () => {
    if (!activeArtist?.name) return;
    closeDialog();
    onFindMusic?.(activeArtist.name);
  });
  dialogLibrary.addEventListener("click", () => { closeDialog(); onOpenLibrary?.(); });
  dialogSearch.addEventListener("click", () => {
    if (!activeArtist?.name) return;
    closeDialog();
    onSearchLibrary?.(activeArtist.name);
  });

  function scheduleProfileReload() {
    profileDirty = true;
    if (panel.hidden) return;
    if (loading) {
      pendingReload = true;
      return;
    }
    window.clearTimeout(dirtyTimer);
    dirtyTimer = window.setTimeout(() => {
      if (!loading) load();
    }, 1200);
  }

  window.addEventListener("puffin:library-updated", scheduleProfileReload);
  window.addEventListener("puffin:metadata-updated", scheduleProfileReload);
  window.addEventListener("puffin:recently-played-updated", () => { profileDirty = true; });
  window.addEventListener("puffin:stats-updated", () => { profileDirty = true; });
  window.addEventListener("puffin:tab-changed", (event) => {
    if (event.detail !== "discover" || loading) return;
    if (!hasLoaded || profileDirty) load();
  });
  window.addEventListener("online", () => {
    if (!hasLoaded || (!currentPayload && !panel.hidden)) load({ force: true, manual: true });
  });

  setRefreshing(true);
  load();
}
