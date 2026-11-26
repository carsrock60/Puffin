import { cacheRemoteArtwork, getMediaBlob, getMediaDisplayTitle, listMediaFiles, recordMediaPlay, recordListeningTime, recordVideoWatchProgress } from "./library.js";
import { initializeDownloader } from "./downloader.js";
import { initializePlaylistLibrary } from "./playlist-library.js";
import { initializeSettings } from "./settings.js";
import { initializeEdit } from "./edit.js";
import { initializeHome } from "./home.js";
import { initializeDiscover } from "./discover.js";
import { initializeStats } from "./stats.js";
import { initializeEqualizer } from "./equalizer.js";
import { initializeWatch } from "./watch.js";
import { initializeListen } from "./listen.js";
import { initializeEnrichment } from "./enrichment.js";
import { renderSyncedLyrics, syncSyncedLyrics } from "./lyrics.js";
import { createSubtitleController, parseWebVtt } from "./video-subtitles.js";
import { createAnimationLoop, normalizeFrequencyLevel } from "./visualizer.js";
import { animateElement, MOTION_EASE, MOTION_SPRING, prefersReducedMotion, translateYOf } from "./motion.js";

const artworkCacheTasks = new Map();
function queueArtworkCache(record) {
  if (!navigator.onLine || !record?.artwork || !/^https?:\/\//i.test(record.artwork)) return;
  if (artworkCacheTasks.has(record.id)) return artworkCacheTasks.get(record.id);
  const task = cacheRemoteArtwork(record)
    .catch((error) => console.warn(`Could not save offline artwork for ${record.name}:`, error))
    .finally(() => artworkCacheTasks.delete(record.id));
  artworkCacheTasks.set(record.id, task);
  return task;
}

async function cacheLibraryArtwork() {
  if (!navigator.onLine) return;
  try {
    const records = await listMediaFiles();
    const remoteArtwork = records.filter((record) => /^https?:\/\//i.test(record.artwork || ""));
    for (let index = 0; index < remoteArtwork.length; index += 4) {
      await Promise.all(remoteArtwork.slice(index, index + 4).map(queueArtworkCache));
    }
  } catch (error) {
    console.warn("Could not check the library for offline artwork:", error);
  }
}

const tabButtons = document.querySelectorAll("[data-tab]");
const panels = document.querySelectorAll("[data-panel]");
const appShell = document.querySelector(".app");
const sidebarCollapse = document.querySelector("#sidebar-collapse");
const mobileMenuOpen = document.querySelector("#mobile-menu-open");
const sidebarScrim = document.querySelector("#sidebar-scrim");
const connectionStatus = document.querySelector("#connection-status");
const playerFullscreen = document.querySelector("#player-fullscreen");
const fullPlayerTitle = document.querySelector("#full-player-title");
const fullPlayerArtist = document.querySelector("#full-player-artist");
const fullPlayerArtwork = document.querySelector("#full-player-artwork");
const fullPlayerLyrics = document.querySelector("#full-player-lyrics");
const fullPlayerLyricsEmpty = document.querySelector("#full-player-lyrics-empty");
const fullPlayerLyricsLines = document.querySelector("#full-player-lyrics-lines");
const fullPlayerLyricsCredit = document.querySelector("#full-player-lyrics-credit");
const fullPlayerQueue = document.querySelector("#full-player-queue");
const fullPlayerEqualizer = document.querySelector("#full-player-equalizer");
const fullPlayerQueueList = document.querySelector("#full-player-queue-list");
const fullPlayerSeek = document.querySelector("#full-player-seek");
const fullPlayerTime = document.querySelector("#full-player-time");
const fullPlayerDuration = document.querySelector("#full-player-duration");
const fullPlayerToggle = document.querySelector("#full-player-toggle");
const playerShuffle = document.querySelector("#player-shuffle");
const playerRepeat = document.querySelector("#player-repeat");
const playerVisualizer = document.querySelector("#player-visualizer");
const playerQueue = document.querySelector("#player-queue");
let queueRecords = [];
let playlistQueueActive = false;
let shuffleEnabled = false;
let repeatMode = 1;
const PLAYER_STATE_KEY = "puffin-playback-state-v1";
let lastPlayerStateSave = 0;
function savePlayerState(force = false) {
  const now = Date.now();
  if (!force && now - lastPlayerStateSave < 1000) return;
  lastPlayerStateSave = now;
  try {
    localStorage.setItem(PLAYER_STATE_KEY, JSON.stringify({
      queue: queueRecords.map((record) => record.id), mediaId: activeMediaId,
      time: activePlayer?.currentTime || 0, shuffle: shuffleEnabled,
      repeat: repeatMode,
    }));
  } catch { /* Storage may be unavailable or full. */ }
}
let playerPane = "lyrics";
let playerModeCloseTimer;
let playerModeReturnFocus = null;
let visualizerAnalyser = null;
let visualizerData = null;
let visualizerSetupPromise = null;
let lyricsSyncFrame = 0;
let equalizerController = null;
let dragQueueId = null;
let queueHoldTimer;
let queueDragRow = null;
let queueDragPointerY = 0;
let queueDragGrabOffset = 0;
const queueRowAnimations = new WeakMap();
const visualizerBars = Array.from({ length: 9 }, () => {
  const bar = document.createElement("span");
  bar.setAttribute("aria-hidden", "true");
  return bar;
});
const visualizerIdleLevels = [0.14, 0.2, 0.3, 0.18, 0.38, 0.18, 0.3, 0.2, 0.14];
const visualizerLevels = [...visualizerIdleLevels];
playerVisualizer.replaceChildren(...visualizerBars);
visualizerBars.forEach((bar, index) => bar.style.setProperty("--level", visualizerLevels[index]));
const visualizerLoop = createAnimationLoop({
  requestFrame: window.requestAnimationFrame.bind(window),
  cancelFrame: window.cancelAnimationFrame.bind(window),
  canRun: () => Boolean(visualizerAnalyser && !document.hidden && activePlayer === audioPlayer
    && !audioPlayer.paused && !audioPlayer.ended && document.documentElement.dataset.reduceMotion !== "true"),
  onFrame: drawVisualizerFrame,
});

function closeMobileSidebar({ restoreFocus = false } = {}) {
  appShell.classList.remove("is-sidebar-open");
  sidebarScrim.hidden = true;
  mobileMenuOpen.setAttribute("aria-expanded", "false");
  mobileMenuOpen.setAttribute("aria-label", "Open navigation");
  mobileMenuOpen.title = "Open navigation";
  if (restoreFocus) mobileMenuOpen.focus({ preventScroll: true });
}

function syncSidebarCollapse(collapsed) {
  appShell.classList.toggle("is-sidebar-collapsed", collapsed);
  sidebarCollapse.setAttribute("aria-expanded", String(!collapsed));
  sidebarCollapse.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  sidebarCollapse.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
  try { localStorage.setItem("puffin.sidebarCollapsed", String(collapsed)); } catch { /* Keep the current setting for this session. */ }
}

let sidebarStartsCollapsed = false;
try { sidebarStartsCollapsed = localStorage.getItem("puffin.sidebarCollapsed") === "true"; } catch { /* Use the expanded sidebar by default. */ }
syncSidebarCollapse(sidebarStartsCollapsed);

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const selectedTab = button.dataset.tab;

    tabButtons.forEach((tab) => {
      if (tab === button) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    });

    panels.forEach((panel) => {
      panel.hidden = panel.dataset.panel !== selectedTab;
    });

    window.dispatchEvent(new CustomEvent("puffin:tab-changed", { detail: selectedTab }));
    if (button.dataset.libraryView) {
      window.dispatchEvent(new CustomEvent("puffin:library-view", { detail: button.dataset.libraryView }));
    }
    updateNavIndicator();
    if (window.matchMedia("(max-width: 720px)").matches) closeMobileSidebar({ restoreFocus: true });
  });
});

const navList = document.querySelector(".nav-list");
const navIndicator = document.createElement("span");
navIndicator.className = "nav-active-indicator";
navIndicator.setAttribute("aria-hidden", "true");
navList.append(navIndicator);
let navIndicatorTarget = null;

function updateNavIndicator({ animate = true } = {}) {
  const active = navList.querySelector('.nav-button[aria-current="page"]');
  const navBox = navList.getBoundingClientRect();
  if (!active || !navBox.width) {
    navIndicator.classList.remove("is-visible");
    return;
  }
  const box = active.getBoundingClientRect();
  const height = Math.max(12, Math.min(18, box.height - 20));
  const x = box.left - navBox.left + 4;
  const y = box.top - navBox.top + (box.height - height) / 2;
  const target = `${x.toFixed(1)}:${y.toFixed(1)}:${height}`;
  navIndicator.style.height = `${height}px`;
  navIndicator.classList.add("is-visible");
  if (navIndicatorTarget === target) return;
  navIndicatorTarget = target;
  if (!animate || prefersReducedMotion()) {
    navIndicator.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    return;
  }
  const current = getComputedStyle(navIndicator).transform;
  let currentX = x;
  let currentY = y;
  if (current && current !== "none") {
    try {
      const matrix = new DOMMatrixReadOnly(current);
      currentX = matrix.m41;
      currentY = matrix.m42;
    } catch { /* Fall back to the target position. */ }
  }
  animateElement(navIndicator, { x: [currentX, x], y: [currentY, y] }, MOTION_SPRING);
}

const navIndicatorResize = new ResizeObserver(() => updateNavIndicator({ animate: false }));
navIndicatorResize.observe(navList);
window.addEventListener("puffin:library-view", () => requestAnimationFrame(() => updateNavIndicator({ animate: false })));
requestAnimationFrame(() => updateNavIndicator({ animate: false }));
document.fonts?.ready.then(() => updateNavIndicator({ animate: false }));

sidebarCollapse.addEventListener("click", () => {
  syncSidebarCollapse(!appShell.classList.contains("is-sidebar-collapsed"));
});
mobileMenuOpen.addEventListener("click", () => {
  const open = appShell.classList.toggle("is-sidebar-open");
  sidebarScrim.hidden = !open;
  mobileMenuOpen.setAttribute("aria-expanded", String(open));
  mobileMenuOpen.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  mobileMenuOpen.title = open ? "Close navigation" : "Open navigation";
  if (open) appShell.querySelector('.nav-button[aria-current="page"]')?.focus({ preventScroll: true });
});
sidebarScrim.addEventListener("click", () => closeMobileSidebar({ restoreFocus: true }));
document.querySelector("#app-sidebar").addEventListener("click", (event) => {
  if (event.target.closest("[data-open-settings]") && window.matchMedia("(max-width: 720px)").matches) {
    closeMobileSidebar();
  }
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && appShell.classList.contains("is-sidebar-open")) {
    closeMobileSidebar({ restoreFocus: true });
  } else if (event.key === "Escape" && !playerFullscreen.hidden) {
    closePlayerMode();
  }
});
window.addEventListener("resize", () => {
  if (!window.matchMedia("(max-width: 720px)").matches) closeMobileSidebar();
});

const libraryStatus = document.querySelector("#library-status");
const playerRevealZone = document.querySelector("#player-reveal-zone");
const playerDock = document.querySelector("#player-dock");
const mainContent = document.querySelector("main");
const mediaPlayer = document.querySelector("#media-player");

function syncPlayerDockSpace() {
  const dockHeight = playerDock.hidden ? 0 : playerDock.getBoundingClientRect().height;
  const dockBottom = playerDock.hidden ? 0 : Number.parseFloat(getComputedStyle(playerDock).bottom) || 0;
  const clearance = dockHeight ? Math.ceil(dockHeight + dockBottom + 16) : 0;
  mainContent.style.setProperty("--player-dock-space", `${clearance}px`);
}

if ("ResizeObserver" in window) {
  const playerDockResizeObserver = new ResizeObserver(syncPlayerDockSpace);
  playerDockResizeObserver.observe(playerDock);
  playerDockResizeObserver.observe(mediaPlayer);
}
const playerDockVisibilityObserver = new MutationObserver(syncPlayerDockSpace);
playerDockVisibilityObserver.observe(playerDock, { attributes: true, attributeFilter: ["hidden"] });
window.addEventListener("resize", syncPlayerDockSpace);
syncPlayerDockSpace();

const playerReveal = document.querySelector("#player-reveal");
const currentMediaTitle = document.querySelector("#current-media-title");
const audioPlayer = document.querySelector("#audio-player");
const videoPlayer = document.querySelector("#video-player");
const playerArtwork = document.querySelector("#player-artwork");
const playerSubtitle = document.querySelector("#player-subtitle");
const playerStatus = document.querySelector("#player-status");
const playerToggle = document.querySelector("#player-toggle");
const playerSeek = document.querySelector("#player-seek");
const playerCurrentTime = document.querySelector("#player-current-time");
const playerDuration = document.querySelector("#player-duration");
const playerSpeed = document.querySelector("#player-speed");
const playerClose = document.querySelector("#player-close");
const playerExpandVideo = document.querySelector("#player-expand-video");
const videoTheater = document.querySelector("#video-theater");
const videoTheaterShell = document.querySelector("#video-theater-shell");
const videoTheaterStage = document.querySelector("#video-theater-stage");
const videoSubtitleOverlay = document.querySelector("#video-subtitle-overlay");
const videoTheaterTitle = document.querySelector("#video-theater-title");
const videoTheaterSubtitle = document.querySelector("#video-theater-subtitle");
const videoTheaterBack = document.querySelector("#video-theater-back");
const videoTheaterClose = document.querySelector("#video-theater-close");
const videoPlayerToggle = document.querySelector("#video-player-toggle");
const videoSeek = document.querySelector("#video-seek");
const videoCurrentTime = document.querySelector("#video-current-time");
const videoDuration = document.querySelector("#video-duration");
const videoVolume = document.querySelector("#video-volume");
const videoSpeed = document.querySelector("#video-speed");
const videoSubtitlesToggle = document.querySelector("#video-subtitles-toggle");
const videoFullscreenToggle = document.querySelector("#video-fullscreen-toggle");
const videoPlayerStatus = document.querySelector("#video-player-status");
const videoTheaterControls = document.querySelector("#video-theater-controls");
const playerVideoFallback = document.querySelector("#player-video-fallback");
const playerTrack = document.querySelector(".player-track");

function setLibraryStatus(message) {
  libraryStatus.textContent = message;
}
playerArtwork.addEventListener("error", () => {
  if (activeMediaRecord?.kind === "video") {
    playerArtwork.hidden = true;
    playerVideoFallback.hidden = false;
  } else {
    playerArtwork.src = "/favicon.svg";
  }
});

let activeMediaId = null;
let activeMediaRecord = null;
let activeObjectUrl = null;
let activeSubtitleUrl = null;
let activeSubtitleElement = null;
let activeSubtitleTrack = null;
let activeSubtitleController = null;
let lastSubtitleGapDiagnostic = null;
let activeSubtitleLanguage = "en";
let activePlayer = null;
let isSeeking = false;
let isVideoSeeking = false;
let playerPinnedOpen = false;
let playerCollapseRequested = false;
let playbackSample = null;
let pendingListeningMs = 0;
let playbackRequestId = 0;
let videoFullscreenNative = false;
let videoControlsTimeout;
let videoHistoryEntry = false;
let videoPriorHistoryState = null;
let videoReturnFocus = null;
let videoTheaterClosePromise = null;
let lastVideoProgressSecond = -1;

function setDockRevealed(revealed) {
  playerDock.classList.toggle("is-revealed", revealed);
}

function setPlayerRevealState(expanded = false) {
  const label = expanded
    ? activeMediaRecord?.kind === "video" ? "Close video player" : "Close full screen player"
    : activeMediaRecord?.kind === "video" ? "Expand video player" : activeMediaRecord ? "Open full screen player" : "Show player controls";
  playerReveal.setAttribute("aria-expanded", String(expanded));
  playerReveal.setAttribute("aria-label", label);
  playerReveal.title = label;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`;
}

function updateConnectionStatus() {
  const online = navigator.onLine;
  connectionStatus.classList.toggle("is-online", online);
  connectionStatus.classList.toggle("is-offline", !online);
  connectionStatus.setAttribute("aria-label", online ? "Online" : "Offline");
  connectionStatus.title = online ? "Online" : "Offline";
  connectionStatus.innerHTML = online
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 8.8a15.5 15.5 0 0 1 20 0M5.5 12.3a10 10 0 0 1 13 0M9 15.8a4.7 4.7 0 0 1 6 0M12 19.5h.01"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 8.8a15.5 15.5 0 0 1 20 0M5.5 12.3a10 10 0 0 1 13 0M9 15.8a4.7 4.7 0 0 1 6 0M12 19.5h.01M3 3l18 18"/></svg>';
}
window.addEventListener("online", updateConnectionStatus);
window.addEventListener("offline", updateConnectionStatus);
updateConnectionStatus();

function renderPlayerLyrics(record = activeMediaRecord) {
  const lineCount = renderSyncedLyrics(
    fullPlayerLyricsLines,
    record?.syncedLyrics || "",
    record?.lyricsTimingAdjustmentMs || 0,
  );
  fullPlayerLyricsEmpty.hidden = lineCount > 0;
  fullPlayerLyricsLines.hidden = lineCount === 0;
  fullPlayerLyricsCredit.hidden = lineCount === 0;
  if (lineCount > 0 && activePlayer === audioPlayer) syncSyncedLyrics(fullPlayerLyricsLines, audioPlayer.currentTime);
}

function stopLyricsSyncLoop() {
  if (lyricsSyncFrame) cancelAnimationFrame(lyricsSyncFrame);
  lyricsSyncFrame = 0;
}

function startLyricsSyncLoop() {
  if (lyricsSyncFrame || document.hidden || playerFullscreen.hidden || playerPane !== "lyrics"
    || activePlayer !== audioPlayer || audioPlayer.paused || audioPlayer.ended) return;
  const update = () => {
    lyricsSyncFrame = 0;
    if (document.hidden || playerFullscreen.hidden || playerPane !== "lyrics"
      || activePlayer !== audioPlayer || audioPlayer.paused || audioPlayer.ended) return;
    syncSyncedLyrics(fullPlayerLyricsLines, audioPlayer.currentTime);
    lyricsSyncFrame = requestAnimationFrame(update);
  };
  lyricsSyncFrame = requestAnimationFrame(update);
}

function stopVisualizerLoop() {
  visualizerLoop.stop();
}

function startVisualizerLoop() {
  visualizerLoop.start();
}

function drawVisualizerFrame() {
  visualizerAnalyser.getByteFrequencyData(visualizerData);
  const binWidth = visualizerAnalyser.context.sampleRate / visualizerAnalyser.fftSize;
  const lowestFrequency = 50;
  const highestFrequency = Math.min(10000, visualizerAnalyser.context.sampleRate / 2);
  visualizerBars.forEach((bar, index) => {
    const startFrequency = lowestFrequency * (highestFrequency / lowestFrequency) ** (index / visualizerBars.length);
    const endFrequency = lowestFrequency * (highestFrequency / lowestFrequency) ** ((index + 1) / visualizerBars.length);
    const firstBin = Math.max(1, Math.floor(startFrequency / binWidth));
    const lastBin = Math.min(visualizerData.length, Math.max(firstBin + 1, Math.ceil(endFrequency / binWidth)));
    const target = normalizeFrequencyLevel(visualizerData, firstBin, lastBin);
    visualizerLevels[index] += (target - visualizerLevels[index]) * (target > visualizerLevels[index] ? 0.82 : 0.36);
    bar.style.setProperty("--level", visualizerLevels[index].toFixed(2));
  });
}

function resetVisualizerBars() {
  stopVisualizerLoop();
  visualizerIdleLevels.forEach((level, index) => {
    visualizerLevels[index] = level;
    visualizerBars[index].style.setProperty("--level", level);
  });
}

async function prepareCompactVisualizer() {
  if (visualizerAnalyser || visualizerSetupPromise || activePlayer !== audioPlayer || !equalizerController) return;
  visualizerSetupPromise = equalizerController.getAnalyser(audioPlayer)
    .then((analyser) => {
      visualizerAnalyser = analyser;
      visualizerData = new Uint8Array(analyser.frequencyBinCount);
      if (activePlayer === audioPlayer && !audioPlayer.paused) startVisualizerLoop();
    })
    .catch((error) => {
      console.warn("Puffin could not start the compact audio visualizer:", error);
    })
    .finally(() => { visualizerSetupPromise = null; });
  return visualizerSetupPromise;
}

function syncCompactVisualizer() {
  const playing = activePlayer === audioPlayer && !audioPlayer.paused && !audioPlayer.ended;
  playerVisualizer.classList.toggle("is-playing", playing);
  if (playing) {
    void prepareCompactVisualizer();
    startVisualizerLoop();
  } else resetVisualizerBars();
}

function setPlayerPane(pane) {
  playerPane = pane;
  fullPlayerLyrics.hidden = pane !== "lyrics";
  fullPlayerQueue.hidden = pane !== "queue";
  fullPlayerEqualizer.hidden = pane !== "equalizer";
  document.querySelectorAll(".full-player-controls button[data-pane]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.pane === pane));
  });
  playerQueue.setAttribute("aria-pressed", String(pane === "queue"));
  document.querySelector("#player-equalizer-open").setAttribute("aria-expanded", String(pane === "equalizer"));
  if (pane === "lyrics") {
    renderPlayerLyrics();
    startLyricsSyncLoop();
  } else stopLyricsSyncLoop();
}

let artworkFlight = null;
let artworkFlightToken = 0;

function stopArtworkFlight({ restore = true } = {}) {
  if (!artworkFlight) return;
  artworkFlightToken += 1;
  artworkFlight.controls?.stop();
  artworkFlight.clone.remove();
  if (restore) artworkFlight.artwork.style.visibility = "";
  artworkFlight = null;
}

function artworkRadius(element, fallback) {
  const radius = Number.parseFloat(getComputedStyle(element).borderRadius);
  return Number.isFinite(radius) ? radius : fallback;
}

function measureFullArtworkRect() {
  const wasClosing = playerFullscreen.classList.contains("is-closing");
  const transition = playerFullscreen.style.transition;
  playerFullscreen.style.transition = "none";
  playerFullscreen.classList.remove("is-closing");
  const rect = fullPlayerArtwork.getBoundingClientRect();
  if (wasClosing) playerFullscreen.classList.add("is-closing");
  playerFullscreen.style.transition = transition;
  return rect;
}

// A single fixed artwork clone carries the cover between the dock and the
// listening stage, so the transition survives interrupted open/close actions.
function runArtworkFlight({ from, to, src, fromRadius, toRadius, hide }) {
  if (!from?.width || !to?.width || !src) return;
  const token = ++artworkFlightToken;
  const clone = document.createElement("img");
  clone.className = "artwork-flight";
  clone.src = src;
  clone.alt = "";
  clone.setAttribute("aria-hidden", "true");
  Object.assign(clone.style, {
    left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px`,
  });
  document.body.append(clone);
  const scale = from.width / to.width;
  const startX = (from.left + from.width / 2) - (to.left + to.width / 2);
  const startY = (from.top + from.height / 2) - (to.top + to.height / 2);
  const controls = animateElement(clone, {
    x: [startX, 0],
    y: [startY, 0],
    scale: [scale, 1],
    borderRadius: [`${fromRadius / scale}px`, `${toRadius}px`],
  }, { duration: 0.32, ease: MOTION_EASE });
  if (!controls) {
    clone.remove();
    return;
  }
  hide.style.visibility = "hidden";
  artworkFlight = { clone, controls, artwork: hide, token };
  controls.finished.then(() => {
    if (token !== artworkFlightToken) return;
    clone.remove();
    hide.style.visibility = "";
    artworkFlight = null;
  }).catch(() => { /* Stopped by a newer transition. */ });
}

function morphArtworkToPlayer(sourceRect, targetRect) {
  stopArtworkFlight();
  if (!sourceRect?.width || !targetRect?.width || prefersReducedMotion()) return;
  runArtworkFlight({
    from: sourceRect,
    to: targetRect,
    src: fullPlayerArtwork.src,
    fromRadius: artworkRadius(playerArtwork, 12),
    toRadius: artworkRadius(fullPlayerArtwork, 22),
    hide: fullPlayerArtwork,
  });
}

function morphArtworkToDock(sourceRect, targetRect) {
  if (!sourceRect?.width || !targetRect?.width || prefersReducedMotion()) return;
  runArtworkFlight({
    from: sourceRect,
    to: targetRect,
    src: fullPlayerArtwork.src,
    fromRadius: artworkRadius(fullPlayerArtwork, 22),
    toRadius: artworkRadius(playerArtwork, 12),
    hide: fullPlayerArtwork,
  });
}

function openPlayerMode(pane = "lyrics") {
  if (!activeMediaRecord || activeMediaRecord.kind !== "audio") return;
  window.clearTimeout(playerModeCloseTimer);
  const wasHidden = playerFullscreen.hidden;
  const wasClosing = !wasHidden && playerFullscreen.classList.contains("is-closing");
  const interruptedRect = wasClosing && artworkFlight ? artworkFlight.clone.getBoundingClientRect() : null;
  if (wasHidden) playerModeReturnFocus = document.activeElement;
  playerFullscreen.hidden = false;
  playerFullscreen.inert = false;
  playerFullscreen.setAttribute("aria-hidden", "false");
  fullPlayerTitle.textContent = getMediaDisplayTitle(activeMediaRecord);
  fullPlayerArtist.textContent = activeMediaRecord.artist || "Puffin Library";
  fullPlayerArtwork.src = activeMediaRecord.artwork || "/favicon.svg";
  if (wasClosing) {
    stopArtworkFlight({ restore: false });
    fullPlayerArtwork.style.visibility = "";
  }
  if (wasHidden || wasClosing) {
    const targetRect = measureFullArtworkRect();
    morphArtworkToPlayer(interruptedRect || playerArtwork.getBoundingClientRect(), targetRect);
  }
  if (wasHidden || wasClosing) {
    playerFullscreen.classList.add("is-closing");
    requestAnimationFrame(() => requestAnimationFrame(() => playerFullscreen.classList.remove("is-closing")));
  }
  setPlayerPane(pane);
  updateFullPlayerControls();
  setPlayerRevealState(true);
  document.querySelector("#full-player-back").focus({ preventScroll: true });
}

function closePlayerMode() {
  if (playerFullscreen.hidden) return;
  setPlayerPane("lyrics");
  const dockRect = playerDock.hidden ? null : playerArtwork.getBoundingClientRect();
  const sourceRect = artworkFlight ? artworkFlight.clone.getBoundingClientRect() : fullPlayerArtwork.getBoundingClientRect();
  stopArtworkFlight();
  morphArtworkToDock(sourceRect, dockRect);
  playerFullscreen.classList.add("is-closing");
  playerFullscreen.inert = true;
  playerFullscreen.setAttribute("aria-hidden", "true");
  setPlayerRevealState(false);
  window.clearTimeout(playerModeCloseTimer);
  playerModeCloseTimer = window.setTimeout(() => {
    stopArtworkFlight();
    fullPlayerArtwork.style.visibility = "";
    playerFullscreen.hidden = true;
    playerFullscreen.classList.remove("is-closing");
    if (playerModeReturnFocus?.isConnected && !playerModeReturnFocus.closest("[hidden]")) playerModeReturnFocus.focus({ preventScroll: true });
    else if (activePlayer === audioPlayer && !playerDock.hidden) playerReveal.focus({ preventScroll: true });
    playerModeReturnFocus = null;
  }, 340);
}

function renderPlayerQueue() {
  fullPlayerQueueList.replaceChildren();
  if (queueRecords.length === 0) {
    const empty = document.createElement("li");
    empty.className = "queue-empty-state";
    empty.textContent = "Your music queue is empty.";
    fullPlayerQueueList.append(empty);
    return;
  }
  queueRecords.forEach((record) => {
    const row = document.createElement("li");
    row.dataset.queueId = record.id;
    row.classList.toggle("is-current", record.id === activeMediaId);
    row.classList.toggle("is-dragging", record.id === dragQueueId);
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "queue-drag-handle";
    handle.textContent = "☰";
    handle.classList.toggle("is-dragging", record.id === dragQueueId);
    handle.setAttribute("aria-label", `Reorder ${getMediaDisplayTitle(record)}. Hold and drag, or use the arrow keys.`);
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      queueDragPointerY = event.clientY;
      window.clearTimeout(queueHoldTimer);
      queueHoldTimer = window.setTimeout(() => {
        if (dragQueueId) return;
        const startY = translateYOf(row);
        queueDragGrabOffset = queueDragPointerY - row.getBoundingClientRect().top;
        queueRowAnimations.get(row)?.stop();
        queueRowAnimations.delete(row);
        row.getAnimations().forEach((animation) => animation.cancel());
        row.style.transform = "";
        row.style.setProperty("--queue-drag-y", `${startY}px`);
        dragQueueId = record.id;
        queueDragRow = row;
        handle.classList.add("is-dragging");
        row.classList.add("is-dragging");
      }, 240);
    });
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const index = queueRecords.findIndex((item) => item.id === record.id);
      const destination = Math.max(0, Math.min(queueRecords.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
      if (!moveQueueRecord(record.id, destination)) return;
      queueRows()
        .find((queueRow) => queueRow.dataset.queueId === record.id)
        ?.querySelector(".queue-drag-handle")?.focus({ preventScroll: true });
    });
    const art = document.createElement("img");
    art.className = "queue-row-art";
    art.src = record.artwork || "/favicon.svg";
    art.alt = "";
    const title = document.createElement("span");
    title.className = "queue-row-title";
    title.textContent = `${getMediaDisplayTitle(record)} · ${record.artist || "Unknown artist"}`;
    const play = document.createElement("button");
    play.type = "button";
    play.className = "queue-row-play";
    play.textContent = record.id === activeMediaId ? "Playing" : "Play";
    play.disabled = record.id === activeMediaId;
    play.addEventListener("click", () => startPlayback(record));
    const actions = document.createElement("details");
    actions.className = "queue-row-menu";
    const summary = document.createElement("summary");
    summary.textContent = "•••";
    summary.setAttribute("aria-label", `Queue actions for ${getMediaDisplayTitle(record)}`);
    const menu = document.createElement("div");
    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "Play next";
    next.addEventListener("click", () => { queueRecords = queueRecords.filter((item) => item.id !== record.id); const current = queueRecords.findIndex((item) => item.id === activeMediaId); queueRecords.splice(Math.max(0, current + 1), 0, record); savePlayerState(true); renderPlayerQueue(); });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove from queue";
    remove.addEventListener("click", () => { queueRecords = queueRecords.filter((item) => item.id !== record.id); savePlayerState(true); renderPlayerQueue(); });
    menu.append(next, remove); actions.append(summary, menu);
    row.append(handle, art, title, play, actions);
    fullPlayerQueueList.append(row);
  });
}

function queueRows() {
  return [...fullPlayerQueueList.querySelectorAll("li[data-queue-id]")];
}

function animateQueueRow(row, keyframes, options) {
  queueRowAnimations.get(row)?.stop();
  const controls = animateElement(row, keyframes, options);
  if (controls) queueRowAnimations.set(row, controls);
  else queueRowAnimations.delete(row);
  return controls;
}

// Reorder the live queue rows instead of re-rendering them mid-drag. The rows
// keep their pointer handlers and focus, and neighbours FLIP from their current
// visual position so rapid, interrupted drags never snap.
function moveQueueRecord(recordId, insertionIndex) {
  const from = queueRecords.findIndex((record) => record.id === recordId);
  if (from < 0) return false;
  const rows = queueRows();
  if (rows.length !== queueRecords.length) return false;
  const destination = Math.max(0, Math.min(queueRecords.length - 1, insertionIndex));
  if (destination === from) return false;
  const layout = new Map(rows.map((row) => [row.dataset.queueId, { top: row.offsetTop, y: translateYOf(row) }]));
  const [record] = queueRecords.splice(from, 1);
  queueRecords.splice(destination, 0, record);
  const row = rows.find((candidate) => candidate.dataset.queueId === recordId);
  const others = rows.filter((candidate) => candidate !== row);
  fullPlayerQueueList.insertBefore(row, others[destination] || null);
  savePlayerState(true);
  for (const candidate of rows) {
    if (candidate === row) continue;
    const before = layout.get(candidate.dataset.queueId);
    if (!before) continue;
    const delta = before.top - candidate.offsetTop;
    const start = before.y + delta;
    if (Math.abs(start) < 0.5) continue;
    animateQueueRow(candidate, { y: [start, 0] }, MOTION_SPRING);
  }
  return true;
}

async function prepareQueue(record) {
  if (record.kind !== "audio") return;
  if (playlistQueueActive && queueRecords.some((item) => item.id === record.id)) { renderPlayerQueue(); return; }
  playlistQueueActive = false;
  try {
    const allAudio = (await listMediaFiles()).filter((item) => item.kind === "audio");
    const available = new Map(allAudio.map((item) => [item.id, item]));
    const inExistingOrder = queueRecords.map((item) => available.get(item.id)).filter(Boolean);
    const included = new Set(inExistingOrder.map((item) => item.id));
    queueRecords = [...inExistingOrder, ...allAudio.filter((item) => !included.has(item.id))];
    if (!queueRecords.some((item) => item.id === record.id)) queueRecords.unshift(record);
  } catch {
    if (!queueRecords.some((item) => item.id === record.id)) queueRecords = [record];
  }
  renderPlayerQueue();
}

function advanceQueue() {
  if (activePlayer !== audioPlayer || queueRecords.length === 0) return;
  if (repeatMode === 2) {
    audioPlayer.currentTime = 0;
    audioPlayer.play().catch(() => {});
    return;
  }
  const current = queueRecords.findIndex((record) => record.id === activeMediaId);
  let next = current + 1;
  if (shuffleEnabled && queueRecords.length > 1) {
    do { next = Math.floor(Math.random() * queueRecords.length); } while (next === current);
  } else if (next >= queueRecords.length) {
    if (repeatMode !== 1) return;
    next = 0;
  }
  if (queueRecords[next]) startPlayback(queueRecords[next]);
}

document.addEventListener("pointermove", (event) => {
  queueDragPointerY = event.clientY;
  if (!dragQueueId) return;
  const rows = queueRows();
  if (rows.length !== queueRecords.length) return;
  const others = rows.filter((row) => row.dataset.queueId !== dragQueueId);
  let destination = others.length;
  for (let index = 0; index < others.length; index += 1) {
    const other = others[index];
    const center = other.getBoundingClientRect().top - translateYOf(other) + other.offsetHeight / 2;
    if (event.clientY < center) { destination = index; break; }
  }
  moveQueueRecord(dragQueueId, destination);
  const dragged = rows.find((row) => row.dataset.queueId === dragQueueId);
  if (!dragged) return;
  const currentY = translateYOf(dragged);
  const layoutTop = dragged.getBoundingClientRect().top - currentY;
  dragged.style.setProperty("--queue-drag-y", `${event.clientY - queueDragGrabOffset - layoutTop}px`);
});
function finishQueueDrag() {
  window.clearTimeout(queueHoldTimer);
  if (!dragQueueId) return;
  const row = queueRows().find((candidate) => candidate.dataset.queueId === dragQueueId) || queueDragRow;
  const currentY = row ? translateYOf(row) : 0;
  dragQueueId = null;
  queueDragRow = null;
  document.querySelectorAll(".queue-drag-handle.is-dragging, .full-player-queue-list li.is-dragging").forEach((element) => element.classList.remove("is-dragging"));
  if (row) {
    row.style.removeProperty("--queue-drag-y");
    row.style.transform = "";
    animateQueueRow(row, { y: [currentY, 0], scale: [1.012, 1] }, { duration: 0.22, ease: MOTION_EASE });
  }
}
document.addEventListener("pointerup", finishQueueDrag);
document.addEventListener("pointercancel", finishQueueDrag);

function updateFullPlayerControls() {
  const player = activePlayer;
  const duration = player && Number.isFinite(player.duration) ? player.duration : 0;
  const current = player && Number.isFinite(player.currentTime) ? player.currentTime : 0;
  fullPlayerSeek.max = String(duration);
  if (document.activeElement !== fullPlayerSeek) fullPlayerSeek.value = String(current);
  fullPlayerTime.textContent = formatTime(current);
  fullPlayerDuration.textContent = formatTime(duration);
  const playing = Boolean(player && !player.paused);
  fullPlayerToggle.textContent = playing ? "Ⅱ" : "▶";
  fullPlayerToggle.setAttribute("aria-label", playing ? "Pause" : "Play");
}

function getPlaybackErrorMessage(player, error) {
  const mediaErrorCode = player.error?.code;
  if (error?.name === "NotAllowedError") {
    return "The browser blocked playback. Tap Play again to allow it.";
  }
  if (error?.name === "NotSupportedError" || mediaErrorCode === 3 || mediaErrorCode === 4) {
    return "This file uses a video or audio codec the browser cannot play. Try an H.264/AAC MP4.";
  }
  if (mediaErrorCode === 2) {
    return "The browser could not load this media file from local storage.";
  }
  return `Playback failed${error?.name ? ` (${error.name})` : ""}.`;
}

function setPlayerStatus(message) {
  playerStatus.textContent = message;
  setLibraryStatus(message);
}

function setAudioSessionForPlayback(recoverStaleSession = false) {
  const session = navigator.audioSession;
  if (!session) return;
  try {
    if (recoverStaleSession && session.type === "playback") {
      // Reset a stale WebKit audio-session category before requesting audio
      // again. Some iOS sessions stop routing sound after a PWA is backgrounded.
      session.type = "ambient";
      window.setTimeout(() => {
        try { session.type = "playback"; } catch { /* The API is optional. */ }
      }, 0);
    } else {
      session.type = "playback";
    }
  } catch { /* Audio Session is not available in every browser. */ }
}

function playPlayerFromGesture(player) {
  // Resume a Web Audio route and request media playback in the same user
  // gesture. iOS can suspend AudioContext when the PWA is backgrounded.
  setAudioSessionForPlayback();
  const resumePromise = equalizerController?.resumeForPlayback?.() || Promise.resolve();
  // WebKit can leave a PWA media element bound to a stale resource after a
  // standalone app is reopened. Re-select the current Blob URL immediately
  // before a fresh start; avoid resetting it when resuming mid-track.
  if (player === activePlayer && activeObjectUrl && player.paused
      && (!Number.isFinite(player.currentTime) || player.currentTime < 0.05)) {
    player.removeAttribute("src");
    player.src = activeObjectUrl;
  }
  const startTime = Number.isFinite(player.currentTime) ? player.currentTime : 0;
  if (player === audioPlayer) void prepareCompactVisualizer();
  const playPromise = player.play();
  const requestId = playbackRequestId;
  window.setTimeout(() => {
    if (requestId !== playbackRequestId || player !== activePlayer || player.paused) return;
    if (player.currentTime <= startTime + 0.05) {
      const errorCode = player.error?.code || "none";
      setAudioSessionForPlayback(true);
      player.pause();
      setPlayerStatus(`Playback stalled (media state ${player.readyState}, error ${errorCode}). Tap Play to retry.`);
    }
  }, 3000);
  return Promise.all([playPromise, resumePromise]);
}

function updatePlayerControls() {
  const duration = activePlayer && Number.isFinite(activePlayer.duration) ? activePlayer.duration : 0;
  const currentTime = activePlayer && Number.isFinite(activePlayer.currentTime) ? activePlayer.currentTime : 0;
  playerSeek.max = String(duration);
  playerSeek.disabled = !activePlayer || duration <= 0;
  if (!isSeeking) playerSeek.value = String(Math.min(currentTime, duration));
  playerCurrentTime.textContent = formatTime(currentTime);
  playerDuration.textContent = formatTime(duration);

  const playing = Boolean(activePlayer && !activePlayer.paused && !activePlayer.ended);
  playerToggle.textContent = playing ? "Ⅱ" : "▶";
  playerToggle.setAttribute("aria-label", playing ? "Pause" : "Play");
  playerToggle.title = playing ? "Pause" : "Play";
  syncCompactVisualizer();
  updateFullPlayerControls();
  updateVideoTheaterControls();
}

function updateMediaSession() {
  const session = navigator.mediaSession;
  if (!session || !activeMediaRecord || !activePlayer) return;
  const record = activeMediaRecord;
  const artwork = record.artwork || "/favicon.svg";
  const sizes = [96, 128, 192, 256, 384, 512];
  try {
    session.metadata = new MediaMetadata({
      title: getMediaDisplayTitle(record),
      artist: record.artist || "Puffin Library",
      album: record.album || "",
      artwork: sizes.map((size) => ({ src: artwork, sizes: `${size}x${size}` })),
    });
    session.playbackState = activePlayer.paused ? "paused" : "playing";
    if (Number.isFinite(activePlayer.duration) && activePlayer.duration > 0) {
      session.setPositionState?.({ duration: activePlayer.duration, playbackRate: activePlayer.playbackRate || 1, position: Math.min(activePlayer.currentTime, activePlayer.duration) });
    }
  } catch { /* Ignore unsupported metadata or position state. */ }
}

function installMediaSessionActions() {
  const session = navigator.mediaSession;
  if (!session) return;
  const actions = {
    play: () => activePlayer && playPlayerFromGesture(activePlayer).catch((error) => setPlayerStatus(getPlaybackErrorMessage(activePlayer, error))),
    pause: () => activePlayer?.pause(),
    stop: () => stopPlayback(),
    nexttrack: () => advanceQueue(),
    previoustrack: () => { if (activePlayer) { activePlayer.currentTime = 0; if (activePlayer.paused) playPlayerFromGesture(activePlayer).catch((error) => setPlayerStatus(getPlaybackErrorMessage(activePlayer, error))); } },
    seekto: (details) => { if (activePlayer && Number.isFinite(details.seekTime)) activePlayer.currentTime = details.seekTime; },
    seekbackward: (details) => { if (activePlayer) activePlayer.currentTime = Math.max(0, activePlayer.currentTime - (details.seekOffset || 10)); },
    seekforward: (details) => { if (activePlayer) activePlayer.currentTime = Math.min(activePlayer.duration || Infinity, activePlayer.currentTime + (details.seekOffset || 10)); },
  };
  for (const [action, handler] of Object.entries(actions)) {
    try { session.setActionHandler(action, handler); } catch { /* Browser does not support this action. */ }
  }
}

function updateVideoTheaterControls() {
  const duration = Number.isFinite(videoPlayer.duration) ? videoPlayer.duration : 0;
  const currentTime = Number.isFinite(videoPlayer.currentTime) ? videoPlayer.currentTime : 0;
  videoSeek.max = String(duration);
  videoSeek.disabled = duration <= 0;
  if (!isVideoSeeking) videoSeek.value = String(Math.min(currentTime, duration));
  videoCurrentTime.textContent = formatTime(currentTime);
  videoDuration.textContent = formatTime(duration);
  const playing = !videoPlayer.paused && !videoPlayer.ended;
  videoPlayerToggle.textContent = playing ? "Ⅱ" : "▶";
  videoPlayerToggle.setAttribute("aria-label", playing ? "Pause video" : "Play video");
  videoPlayerToggle.title = playing ? "Pause" : "Play";
  videoPlayerToggle.setAttribute("aria-pressed", String(playing));
  videoVolume.value = String(videoPlayer.volume);
  videoSpeed.value = String(videoPlayer.playbackRate || 1);
  const fullscreen = isVideoFullscreenActive();
  videoFullscreenToggle.textContent = fullscreen ? "⛶" : "⛶";
  videoFullscreenToggle.setAttribute("aria-label", fullscreen ? "Exit fullscreen" : "Enter fullscreen");
  videoFullscreenToggle.title = fullscreen ? "Exit fullscreen" : "Enter fullscreen";
  videoFullscreenToggle.setAttribute("aria-pressed", String(fullscreen));
}

function updateVideoSubtitleButton() {
  const available = Boolean(activeSubtitleController?.available);
  const enabled = Boolean(activeSubtitleController?.enabled);
  const languageName = getSubtitleLanguageName(activeSubtitleLanguage);
  videoSubtitlesToggle.disabled = !available;
  videoSubtitlesToggle.setAttribute("aria-pressed", String(enabled));
  videoSubtitlesToggle.setAttribute("aria-label", available ? (enabled ? `Turn ${languageName} subtitles off` : `Turn ${languageName} subtitles on`) : "Subtitles unavailable");
  videoSubtitlesToggle.title = available ? (enabled ? `Turn ${languageName} subtitles off` : `Turn ${languageName} subtitles on`) : "No downloadable subtitles are available";
}

function getSubtitleLanguageName(language) {
  try {
    return new Intl.DisplayNames([navigator.language || "en"], { type: "language" }).of(language) || language;
  } catch {
    return language;
  }
}

function updateVideoSubtitleOverlay() {
  const currentTime = videoPlayer.currentTime;
  const state = activeSubtitleController?.update(currentTime) || { available: false, enabled: false, text: "", visible: false };
  const nativeFullscreen = Boolean(videoFullscreenNative || videoPlayer.webkitDisplayingFullscreen);
  if (Number.isFinite(currentTime) && state.enabled && state.available && !state.text) {
    const nextCue = activeSubtitleController.cues.find((cue) => cue.start > currentTime);
    const gapKey = nextCue ? `next:${nextCue.start}` : "after-final-cue";
    if (gapKey !== lastSubtitleGapDiagnostic) {
      console.debug("[Puffin subtitles] Enabled, but no cue is active at the current time.", {
        currentTime,
        nextCueAt: nextCue?.start ?? null,
      });
      lastSubtitleGapDiagnostic = gapKey;
    }
  } else {
    lastSubtitleGapDiagnostic = null;
  }
  if (activeSubtitleTrack) {
    activeSubtitleTrack.mode = nativeFullscreen && state.enabled ? "showing" : "hidden";
  }
}

function clearVideoSubtitles() {
  if (activeSubtitleElement) activeSubtitleElement.remove();
  if (activeSubtitleUrl) URL.revokeObjectURL(activeSubtitleUrl);
  activeSubtitleElement = null;
  activeSubtitleTrack = null;
  activeSubtitleUrl = null;
  activeSubtitleController = null;
  lastSubtitleGapDiagnostic = null;
  activeSubtitleLanguage = "en";
  videoSubtitleOverlay.textContent = "";
  videoSubtitleOverlay.hidden = true;
  updateVideoSubtitleButton();
}

function attachVideoSubtitles(record) {
  clearVideoSubtitles();
  videoPlayerStatus.textContent = "";
  updateVideoSubtitleButton();
  if (record.kind !== "video" || !record.subtitles) {
    console.info("[Puffin subtitles] No subtitle text was downloaded for this video.", { mediaId: record.id });
    videoPlayerStatus.textContent = "No downloadable subtitles are available for this video.";
    return;
  }
  activeSubtitleLanguage = record.subtitleLanguage || "en";
  const parsed = parseWebVtt(record.subtitles);
  if (parsed.error) {
    console.warn("[Puffin subtitles] Subtitle file could not be parsed.", {
      mediaId: record.id,
      reason: parsed.error,
      invalidCueCount: parsed.invalidCueCount,
      characterCount: record.subtitles.length,
    });
    videoPlayerStatus.textContent = "This video's subtitle file has no usable captions.";
    updateVideoSubtitleButton();
    return;
  }
  activeSubtitleController = createSubtitleController(parsed.cues, ({ text, visible }) => {
    videoSubtitleOverlay.textContent = visible ? text : "";
    videoSubtitleOverlay.hidden = !visible || videoFullscreenNative || Boolean(videoPlayer.webkitDisplayingFullscreen);
  });
  console.debug("[Puffin subtitles] Parsed usable caption cues.", {
    mediaId: record.id,
    cueCount: parsed.cues.length,
    invalidCueCount: parsed.invalidCueCount,
  });
  activeSubtitleUrl = URL.createObjectURL(new Blob([record.subtitles], { type: "text/vtt;charset=utf-8" }));
  const trackElement = document.createElement("track");
  trackElement.kind = "subtitles";
  trackElement.label = getSubtitleLanguageName(activeSubtitleLanguage);
  trackElement.srclang = activeSubtitleLanguage;
  trackElement.default = false;
  trackElement.src = activeSubtitleUrl;
  trackElement.addEventListener("load", () => {
    if (activeSubtitleElement !== trackElement || !activeSubtitleTrack) return;
    const nativeCueCount = activeSubtitleTrack.cues?.length ?? 0;
    const diagnostics = {
      mediaId: record.id,
      cueCount: nativeCueCount,
      readyState: trackElement.readyState,
    };
    if (nativeCueCount) console.debug("[Puffin subtitles] Native fullscreen fallback track loaded.", diagnostics);
    else console.warn("[Puffin subtitles] Native fallback loaded without cues; custom theater captions remain available.", diagnostics);
    updateVideoSubtitleOverlay();
  });
  trackElement.addEventListener("error", () => {
    if (activeSubtitleElement !== trackElement) return;
    console.warn("[Puffin subtitles] Native fullscreen fallback track failed to load; theater overlay remains available.", {
      mediaId: record.id,
      trackReadyState: trackElement.readyState,
    });
    activeSubtitleTrack = null;
    updateVideoSubtitleOverlay();
  });
  activeSubtitleElement = trackElement;
  videoPlayer.append(trackElement);
  activeSubtitleTrack = trackElement.track;
  activeSubtitleTrack.mode = "hidden";
  updateVideoSubtitleButton();
  updateVideoSubtitleOverlay();
}

function getStandardFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function isVideoFullscreenActive() {
  const fullscreenElement = getStandardFullscreenElement();
  return Boolean(videoFullscreenNative || videoPlayer.webkitDisplayingFullscreen
    || fullscreenElement && (fullscreenElement === videoTheaterShell || videoTheaterShell.contains(fullscreenElement)));
}

function syncFullscreenState() {
  const nativeFullscreen = Boolean(videoFullscreenNative || videoPlayer.webkitDisplayingFullscreen);
  videoTheater.classList.toggle("is-native-fullscreen", nativeFullscreen);
  updateVideoTheaterControls();
  if (!isVideoFullscreenActive()) {
    videoPlayer.controls = false;
    if (videoTheater.open) {
      revealVideoControls();
      scheduleVideoControlsHide();
    }
  }
}

function revealVideoControls() {
  window.clearTimeout(videoControlsTimeout);
  videoTheater.classList.remove("is-controls-hidden");
}

function scheduleVideoControlsHide() {
  window.clearTimeout(videoControlsTimeout);
  const focusIsOnControl = videoTheaterControls.contains(document.activeElement)
    || videoTheaterBack === document.activeElement || videoTheaterClose === document.activeElement;
  if (!videoTheater.open || focusIsOnControl) return;
  videoControlsTimeout = window.setTimeout(() => {
    const focusStillOnControl = videoTheaterControls.contains(document.activeElement)
      || videoTheaterBack === document.activeElement || videoTheaterClose === document.activeElement;
    if (videoTheater.open && !focusStillOnControl) {
      videoTheater.classList.add("is-controls-hidden");
    }
  }, 3000);
}

function sampleVideoProgress(force = false) {
  if (activePlayer !== videoPlayer || !activeMediaId) return;
  const second = Math.floor(videoPlayer.currentTime || 0);
  if (second < 1) return;
  if (!force && second - lastVideoProgressSecond < 8) return;
  lastVideoProgressSecond = second;
  recordVideoWatchProgress(activeMediaId, videoPlayer.currentTime || 0, videoPlayer.duration)
    .catch((error) => console.warn("Could not save video watch progress:", error));
}

function sampleListeningTime(player, allowStopped = false) {
  if (player !== activePlayer || player !== audioPlayer || (!allowStopped && (player.paused || player.ended))) {
    playbackSample = null;
    return;
  }
  const now = performance.now();
  const position = player.currentTime;
  if (playbackSample) {
    const elapsed = now - playbackSample.wallTime;
    const mediaElapsed = position - playbackSample.position;
    if (elapsed > 0 && elapsed <= 7000 && mediaElapsed > 0 && mediaElapsed <= (elapsed / 1000) * 2.5 + 0.75) {
      pendingListeningMs += elapsed;
    }
  }
  playbackSample = { wallTime: now, position };
  if (pendingListeningMs >= 15000) flushListeningTime();
}

async function flushListeningTime() {
  const milliseconds = pendingListeningMs;
  pendingListeningMs = 0;
  if (milliseconds > 0) {
    try { await recordListeningTime(milliseconds); }
    catch (error) { console.warn("Could not save listening time:", error); }
  }
}

function addVideoHistoryEntry() {
  if (videoHistoryEntry) return;
  const previousState = history.state && typeof history.state === "object" ? history.state : {};
  try {
    videoPriorHistoryState = history.state;
    history.pushState({ ...previousState, puffinVideoOverlay: true }, "", window.location.href);
    videoHistoryEntry = true;
  } catch {
    videoPlayerStatus.textContent = "Browser navigation shortcuts are unavailable; use Back or Close in the player.";
  }
}

async function exitVideoFullscreen() {
  const fullscreenElement = getStandardFullscreenElement();
  if (fullscreenElement && (fullscreenElement === videoTheaterShell || videoTheaterShell.contains(fullscreenElement))) {
    const exitFullscreen = document.exitFullscreen || document.webkitExitFullscreen;
    if (exitFullscreen) {
      try { await exitFullscreen.call(document); } catch { /* The browser may already have exited fullscreen. */ }
    }
  }
  if (videoFullscreenNative || videoPlayer.webkitDisplayingFullscreen) {
    const endEvent = new Promise((resolve) => videoPlayer.addEventListener("webkitendfullscreen", resolve, { once: true }));
    try { videoPlayer.webkitExitFullscreen?.(); } catch { /* WebKit may already have exited native video fullscreen. */ }
    await Promise.race([endEvent, new Promise((resolve) => window.setTimeout(resolve, 700))]);
    videoFullscreenNative = false;
    videoPlayer.controls = false;
    updateVideoSubtitleOverlay();
    syncFullscreenState();
  }
}

async function closeVideoTheater({ fromHistory = false } = {}) {
  if (!videoTheater.open) return;
  if (fromHistory) videoHistoryEntry = false;
  if (videoTheaterClosePromise) return videoTheaterClosePromise;
  videoTheaterClosePromise = (async () => {
    await exitVideoFullscreen();
    if (videoTheater.open) videoTheater.close();
  })();
  try {
    await videoTheaterClosePromise;
  } finally {
    videoTheaterClosePromise = null;
  }
}

function openVideoTheater() {
  if (activePlayer !== videoPlayer || videoTheater.open || videoTheaterClosePromise) return;
  videoTheaterTitle.textContent = activeMediaRecord ? getMediaDisplayTitle(activeMediaRecord) : "Now playing";
  videoTheaterSubtitle.textContent = [activeMediaRecord?.artist, activeMediaRecord?.album].filter(Boolean).join(" · ") || "Puffin video library";
  videoPlayer.controls = false;
  videoPlayer.hidden = false;
  videoTheaterStage.append(videoPlayer);
  setPlayerRevealState(true);
  playerDock.hidden = true;
  videoReturnFocus = document.activeElement === document.body || document.activeElement === document.documentElement
    ? null
    : document.activeElement;
  videoTheater.showModal();
  addVideoHistoryEntry();
  revealVideoControls();
  updateVideoTheaterControls();
  videoPlayer.focus({ preventScroll: true });
  scheduleVideoControlsHide();
}

function restoreVideoToPlayer() {
  window.clearTimeout(videoControlsTimeout);
  videoTheater.classList.remove("is-controls-hidden", "is-native-fullscreen");
  if (videoPlayer.parentElement !== playerTrack) {
    playerTrack.insertBefore(videoPlayer, playerVideoFallback);
  }
  videoPlayer.controls = false;
  videoPlayer.setAttribute("aria-label", "Expand video");
  videoPlayer.hidden = false;
  playerDock.hidden = !activePlayer;
  setPlayerRevealState(false);
  setDockRevealed(Boolean(activePlayer));
  if (videoReturnFocus?.isConnected) videoReturnFocus.focus({ preventScroll: true });
  else if (document.querySelector('[data-tab="watch"][aria-current="page"]')) document.querySelector("#watch-title").focus({ preventScroll: true });
  else if (activePlayer) playerToggle.focus({ preventScroll: true });
  videoReturnFocus = null;
  if (videoHistoryEntry) {
    videoHistoryEntry = false;
    if (history.state?.puffinVideoOverlay) history.back();
  }
  videoPriorHistoryState = null;
}

async function startPlayback(record, startTime = 0, openVideo = false, autoplay = true) {
  const requestId = ++playbackRequestId;
  try {
    if (activePlayer === videoPlayer) sampleVideoProgress(true);
    if (videoTheater.open) await closeVideoTheater();
    if (requestId !== playbackRequestId) return;
    sampleListeningTime(activePlayer);
    await flushListeningTime();
    const blob = await getMediaBlob(record.id);
    if (requestId !== playbackRequestId) return;
    if (!blob) throw new Error("The media file is missing from local storage.");

    audioPlayer.pause();
    videoPlayer.pause();
    clearVideoSubtitles();
    audioPlayer.removeAttribute("src");
    videoPlayer.removeAttribute("src");
    audioPlayer.load();
    videoPlayer.load();
    if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);

    const playableBlob = blob.type === record.type
      ? blob
      : blob.slice(0, blob.size, record.type);
    activeObjectUrl = URL.createObjectURL(playableBlob);
    activeMediaId = record.id;
    activeMediaRecord = record;
    updateMediaSession();
    if (record.kind === "video" && !playerFullscreen.hidden) closePlayerMode();
    void prepareQueue(record);
    renderPlayerQueue();
    if (playerFullscreen && !playerFullscreen.hidden && record.kind === "audio") {
      fullPlayerTitle.textContent = getMediaDisplayTitle(record);
      fullPlayerArtist.textContent = record.artist || "Puffin Library";
      fullPlayerArtwork.src = record.artwork || "/favicon.svg";
      renderPlayerLyrics(record);
    }
    lastVideoProgressSecond = -1;
    playerCollapseRequested = false;
    playerPinnedOpen = true;
    setPlayerRevealState(false);
    currentMediaTitle.textContent = getMediaDisplayTitle(record);
    playerSubtitle.textContent = record.artist || "Puffin Library";
    const isVideo = record.kind === "video";
    [playerShuffle, playerRepeat, playerQueue].forEach((button) => { button.disabled = isVideo; });
    document.querySelector("#player-equalizer-open").disabled = isVideo;
    playerTrack.classList.toggle("is-video", isVideo);
    if (record.artwork) playerArtwork.src = record.artwork;
    else if (!isVideo) playerArtwork.src = "/favicon.svg";
    playerArtwork.hidden = isVideo && !record.artwork;
    playerVideoFallback.hidden = !isVideo || Boolean(record.artwork);
    playerExpandVideo.hidden = !isVideo;
    playerDock.hidden = false;
    mediaPlayer.hidden = false;

    const player = record.kind === "video" ? videoPlayer : audioPlayer;
    const otherPlayer = player === videoPlayer ? audioPlayer : videoPlayer;
    otherPlayer.hidden = true;
    player.hidden = false;
    if (player === videoPlayer) attachVideoSubtitles(record);
    player.src = activeObjectUrl;
    player.playbackRate = 1;
    player.defaultPlaybackRate = 1;
    playerSpeed.value = "1";
    activePlayer = player;
    setPlayerRevealState(false);
    setDockRevealed(true);
    setPlayerStatus("");
    playerSubtitle.textContent = record.kind === "video" ? `Video · ${record.artist || "Puffin Library"}` : "Puffin Library";
    document.body.classList.add("has-player");
    if (startTime > 0) {
      const resume = () => {
        if (activeMediaId === record.id && Number.isFinite(player.duration)) {
          player.currentTime = Math.min(startTime, Math.max(0, player.duration - 0.25));
          savePlayerState(true);
        }
      };
      if (player.readyState >= 1) resume();
      else player.addEventListener("loadedmetadata", resume, { once: true });
    }
    if (player === videoPlayer && openVideo) openVideoTheater();
    updatePlayerControls();

    try {
      if (autoplay) await playPlayerFromGesture(player);
      if (autoplay) recordMediaPlay(record.id).catch((error) => console.warn("Could not update recent plays:", error));
      updatePlayerControls();
      savePlayerState(true);
      setPlayerStatus("");
      if (player === videoPlayer) sampleVideoProgress(true);
    } catch (error) {
      updatePlayerControls();
      const message = `${getPlaybackErrorMessage(player, error)} Track: ${record.name}.`;
      setPlayerStatus(message);
      if (player === videoPlayer) videoPlayerStatus.textContent = getPlaybackErrorMessage(player, error);
    }
  } catch (error) {
    setPlayerStatus(`Could not open this file: ${error.message}`);
  }
}

async function stopPlayback() {
  playbackRequestId += 1;
  closePlayerMode();
  if (activePlayer === videoPlayer) sampleVideoProgress(true);
  sampleListeningTime(activePlayer);
  audioPlayer.pause();
  videoPlayer.pause();
  clearVideoSubtitles();
  await flushListeningTime();
  if (videoTheater.open) await closeVideoTheater();
  else if (isVideoFullscreenActive()) await exitVideoFullscreen();
  audioPlayer.removeAttribute("src");
  videoPlayer.removeAttribute("src");
  audioPlayer.load();
  videoPlayer.load();
  if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
  activeObjectUrl = null;
  activeMediaId = null;
  activeMediaRecord = null;
  activePlayer = null;
  if (navigator.mediaSession) {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = "none";
  }
  isSeeking = false;
  mediaPlayer.hidden = true;
  playerDock.hidden = true;
  playerPinnedOpen = false;
  playerCollapseRequested = false;
  setDockRevealed(false);
  setPlayerRevealState(false);
  playerArtwork.hidden = false;
  playerVideoFallback.hidden = true;
  playerExpandVideo.hidden = true;
  [playerShuffle, playerRepeat, playerQueue].forEach((button) => { button.disabled = true; });
  document.querySelector("#player-equalizer-open").disabled = true;
  playerTrack.classList.remove("is-video");
  playerSubtitle.textContent = "Puffin Library";
  setPlayerStatus("");
  document.body.classList.remove("has-player");
  try { localStorage.removeItem(PLAYER_STATE_KEY); } catch { /* Storage may be unavailable. */ }
  updatePlayerControls();
}

initializePlaylistLibrary({
  onPlay: (record) => startPlayback(record, 0, record.kind === "video"),
  onDeleted: (record) => {
    if (activeMediaId === record.id) stopPlayback();
  },
});

window.addEventListener("puffin:metadata-updated", (event) => {
  const record = event.detail;
  if (!record) return;
  queueArtworkCache(record);
  const queuedRecord = queueRecords.find((item) => item.id === record.id);
  if (queuedRecord) Object.assign(queuedRecord, record);
  if (record.id !== activeMediaId) return;
  currentMediaTitle.textContent = getMediaDisplayTitle(record);
  playerSubtitle.textContent = record.kind === "video" ? `Video · ${record.artist || "Puffin Library"}` : (record.artist || "Puffin Library");
  if (playerFullscreen && !playerFullscreen.hidden && record.kind === "audio") {
    fullPlayerTitle.textContent = getMediaDisplayTitle(record);
    fullPlayerArtist.textContent = record.artist || "Puffin Library";
    fullPlayerArtwork.src = record.artwork || "/favicon.svg";
    renderPlayerLyrics(record);
  }
  activeMediaRecord = record;
  updateMediaSession();
  if (record.artwork) playerArtwork.src = record.artwork;
  playerArtwork.hidden = record.kind === "video" && !record.artwork;
  playerVideoFallback.hidden = record.kind !== "video" || Boolean(record.artwork);
  playerExpandVideo.hidden = record.kind !== "video";
  if (videoTheater.open) {
    videoTheaterTitle.textContent = getMediaDisplayTitle(record);
    videoTheaterSubtitle.textContent = [record.artist, record.album].filter(Boolean).join(" · ") || "Puffin video library";
  }
});

for (const player of [audioPlayer, videoPlayer]) {
  for (const eventName of ["loadedmetadata", "durationchange", "timeupdate", "play", "pause", "ended"]) {
    player.addEventListener(eventName, () => {
      updatePlayerControls();
      if (player === activePlayer) updateMediaSession();
      if (player === videoPlayer) updateVideoSubtitleOverlay();
    });
  }
  player.addEventListener("play", () => {
    if (player === audioPlayer && player === activePlayer) syncCompactVisualizer();
    if (player === activePlayer) setPlayerStatus("");
    if (player === activePlayer && player === audioPlayer) {
      playbackSample = { wallTime: performance.now(), position: player.currentTime };
      startLyricsSyncLoop();
    }
  });
  player.addEventListener("timeupdate", () => sampleListeningTime(player));
  player.addEventListener("timeupdate", () => { if (player === activePlayer) savePlayerState(); });
  player.addEventListener("timeupdate", () => {
    if (player === videoPlayer) sampleVideoProgress();
    if (player === audioPlayer && playerPane === "lyrics" && !playerFullscreen.hidden) {
      syncSyncedLyrics(fullPlayerLyricsLines, audioPlayer.currentTime);
    }
    if (videoTheater.open) updateVideoTheaterControls();
  });
  player.addEventListener("play", () => {
    if (player === videoPlayer) {
      updateVideoTheaterControls();
      if (videoTheater.open) scheduleVideoControlsHide();
    }
  });
  for (const eventName of ["pause", "ended"]) {
    player.addEventListener(eventName, () => {
      sampleListeningTime(player, true);
      flushListeningTime();
      if (player === videoPlayer) sampleVideoProgress(true);
      if (player === audioPlayer && player.ended) advanceQueue();
      if (player === audioPlayer) {
        syncSyncedLyrics(fullPlayerLyricsLines, audioPlayer.currentTime);
        stopLyricsSyncLoop();
      }
      if (videoTheater.open) {
        revealVideoControls();
        scheduleVideoControlsHide();
      }
      updateVideoTheaterControls();
    });
  }
  player.addEventListener("seeking", () => {
    if (player === activePlayer) {
      playbackSample = { wallTime: performance.now(), position: player.currentTime };
      if (player === audioPlayer) syncSyncedLyrics(fullPlayerLyricsLines, player.currentTime);
    }
  });
  player.addEventListener("seeked", () => {
    if (player === activePlayer && player === audioPlayer) {
      syncSyncedLyrics(fullPlayerLyricsLines, player.currentTime);
      startLyricsSyncLoop();
    }
  });
  player.addEventListener("error", () => {
    const message = getPlaybackErrorMessage(player);
    setPlayerStatus(message);
    if (player === videoPlayer) videoPlayerStatus.textContent = message;
  });
}

playerToggle.addEventListener("click", async () => {
  if (!activePlayer) return;
  if (activePlayer.paused) {
    try {
      await playPlayerFromGesture(activePlayer);
      setPlayerStatus("");
    } catch (error) {
      setPlayerStatus(getPlaybackErrorMessage(activePlayer, error));
    }
  } else {
    activePlayer.pause();
  }
  updatePlayerControls();
});

function commitSeek() {
  if (!activePlayer || !Number.isFinite(activePlayer.duration)) {
    isSeeking = false;
    return;
  }
  activePlayer.currentTime = Number(playerSeek.value);
  isSeeking = false;
  updatePlayerControls();
}

window.addEventListener("pagehide", () => { sampleListeningTime(activePlayer); flushListeningTime(); });
document.addEventListener("visibilitychange", () => {
  syncFullscreenState();
  if (document.hidden) {
    stopVisualizerLoop();
    stopLyricsSyncLoop();
    sampleListeningTime(activePlayer); flushListeningTime(); sampleVideoProgress(true);
  } else {
    if (activePlayer && !activePlayer.paused) playbackSample = { wallTime: performance.now(), position: activePlayer.currentTime };
    syncCompactVisualizer();
    if (activePlayer === audioPlayer && !audioPlayer.paused) {
      syncSyncedLyrics(fullPlayerLyricsLines, audioPlayer.currentTime);
      startLyricsSyncLoop();
    }
  }
});

playerSeek.addEventListener("pointerdown", () => {
  isSeeking = true;
});

playerSeek.addEventListener("pointerup", commitSeek);
playerSeek.addEventListener("pointercancel", commitSeek);
playerSeek.addEventListener("change", commitSeek);
playerSeek.addEventListener("input", () => {
  isSeeking = true;
  playerCurrentTime.textContent = formatTime(Number(playerSeek.value));
});

playerSpeed.addEventListener("change", () => {
  const speed = Number(playerSpeed.value);
  audioPlayer.playbackRate = speed;
  videoPlayer.playbackRate = speed;
  videoSpeed.value = String(speed);
});

playerClose.addEventListener("click", stopPlayback);
window.addEventListener("puffin:add-to-queue", (event) => {
  const record = event.detail;
  if (!record || record.kind !== "audio" || queueRecords.some((item) => item.id === record.id)) return;
  queueRecords.push(record);
  savePlayerState(true);
  renderPlayerQueue();
});
function setShuffle(enabled) {
  shuffleEnabled = enabled;
  [playerShuffle, document.querySelector("#full-player-shuffle")].forEach((button) => button.setAttribute("aria-pressed", String(enabled)));
  savePlayerState(true);
}
function cycleRepeat() {
  repeatMode = (repeatMode + 1) % 3;
  const labels = ["Repeat off", "Repeat all", "Repeat one"];
  playerRepeat.textContent = repeatMode === 2 ? "↻¹" : "↻";
  playerRepeat.setAttribute("aria-label", labels[repeatMode]);
  playerRepeat.title = labels[repeatMode];
  playerRepeat.setAttribute("aria-pressed", String(repeatMode !== 0));
  const fullRepeat = document.querySelector("#full-player-repeat");
  fullRepeat.textContent = labels[repeatMode];
  fullRepeat.setAttribute("aria-label", labels[repeatMode]);
  fullRepeat.setAttribute("aria-pressed", String(repeatMode !== 0));
  savePlayerState(true);
}
playerShuffle.addEventListener("click", () => setShuffle(!shuffleEnabled));
document.querySelector("#full-player-shuffle").addEventListener("click", () => setShuffle(!shuffleEnabled));
playerRepeat.addEventListener("click", cycleRepeat);
document.querySelector("#full-player-repeat").addEventListener("click", cycleRepeat);
playerQueue.addEventListener("click", async () => {
  if (activeMediaRecord?.kind !== "audio") return;
  if (!playerFullscreen.hidden && playerPane === "queue") { setPlayerPane("lyrics"); return; }
  await prepareQueue(activeMediaRecord);
  if (playerFullscreen.hidden) openPlayerMode("queue");
  else setPlayerPane("queue");
});
document.querySelector("#full-player-queue-button").addEventListener("click", async () => {
  if (playerPane === "queue") { setPlayerPane("lyrics"); return; }
  if (activeMediaRecord) await prepareQueue(activeMediaRecord);
  setPlayerPane("queue");
});
document.querySelector("#full-player-eq-button").addEventListener("click", () => {
  setPlayerPane(playerPane === "equalizer" ? "lyrics" : "equalizer");
});
document.querySelector("#full-player-back").addEventListener("click", closePlayerMode);
document.querySelector("#queue-clear").addEventListener("click", () => {
  if (queueRecords.length > 1 && !window.confirm("Clear all upcoming tracks from the queue?")) return;
  queueRecords = activeMediaId ? queueRecords.filter((record) => record.id === activeMediaId) : [];
  savePlayerState(true);
  renderPlayerQueue();
});
document.querySelector("#full-player-toggle").addEventListener("click", async () => {
  if (!activePlayer) return;
  if (activePlayer.paused) {
    try { await playPlayerFromGesture(activePlayer); setPlayerStatus(""); }
    catch (error) { setPlayerStatus(getPlaybackErrorMessage(activePlayer, error)); }
  }
  else activePlayer.pause();
  updatePlayerControls();
});
const commitFullPlayerSeek = () => {
  if (activePlayer && Number.isFinite(activePlayer.duration)) activePlayer.currentTime = Number(fullPlayerSeek.value);
};
fullPlayerSeek.addEventListener("change", commitFullPlayerSeek);
fullPlayerSeek.addEventListener("pointerup", commitFullPlayerSeek);
window.addEventListener("puffin:player-mode", (event) => {
  const pane = event.detail || "lyrics";
  if (pane === "lyrics") {
    if (playerFullscreen.hidden) openPlayerMode("lyrics");
    else setPlayerPane("lyrics");
    return;
  }
  if (!playerFullscreen.hidden && playerPane === pane) setPlayerPane("lyrics");
  else openPlayerMode(pane);
});
playerExpandVideo.addEventListener("click", (event) => {
  event.stopPropagation();
  openVideoTheater();
});
videoPlayerToggle.addEventListener("click", async () => {
  if (activePlayer !== videoPlayer) return;
  if (videoPlayer.paused) {
    try { await playPlayerFromGesture(videoPlayer); setPlayerStatus(""); }
    catch (error) { const message = getPlaybackErrorMessage(videoPlayer, error); setPlayerStatus(message); videoPlayerStatus.textContent = message; }
  } else videoPlayer.pause();
  revealVideoControls();
  updatePlayerControls();
});
videoSubtitlesToggle.addEventListener("click", () => {
  if (!activeSubtitleController?.available) return;
  activeSubtitleController.toggle();
  updateVideoSubtitleOverlay();
  updateVideoSubtitleButton();
  revealVideoControls();
  scheduleVideoControlsHide();
});
videoVolume.addEventListener("input", () => { videoPlayer.volume = Number(videoVolume.value); });
videoSpeed.addEventListener("change", () => {
  const speed = Number(videoSpeed.value);
  videoPlayer.playbackRate = speed;
  playerSpeed.value = String(speed);
});
videoSeek.addEventListener("pointerdown", () => { isVideoSeeking = true; });
function commitVideoSeek() {
  if (Number.isFinite(videoPlayer.duration)) videoPlayer.currentTime = Number(videoSeek.value);
  isVideoSeeking = false;
  updateVideoSubtitleOverlay();
  updateVideoTheaterControls();
}
videoSeek.addEventListener("pointerup", commitVideoSeek);
videoSeek.addEventListener("pointercancel", commitVideoSeek);
videoSeek.addEventListener("change", commitVideoSeek);
videoSeek.addEventListener("input", () => {
  isVideoSeeking = true;
  videoCurrentTime.textContent = formatTime(Number(videoSeek.value));
});

async function toggleVideoFullscreen() {
  if (isVideoFullscreenActive()) {
    await exitVideoFullscreen();
    syncFullscreenState();
    return;
  }
  try {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const nativeVideoFullscreen = typeof videoPlayer.webkitEnterFullscreen === "function";
    if (isIOS && nativeVideoFullscreen) {
      videoPlayer.controls = true;
      videoPlayer.webkitEnterFullscreen();
      return;
    }
    const requestFullscreen = videoTheaterShell.requestFullscreen || videoTheaterShell.webkitRequestFullscreen;
    if (requestFullscreen && document.fullscreenEnabled !== false) {
      await requestFullscreen.call(videoTheaterShell);
      return;
    }
    if (nativeVideoFullscreen) {
      videoPlayer.controls = true;
      videoPlayer.webkitEnterFullscreen();
      return;
    }
    videoPlayerStatus.textContent = "Fullscreen is unavailable in this browser. The expanded player already fills the screen.";
  } catch {
    if (typeof videoPlayer.webkitEnterFullscreen === "function") {
      try {
        videoPlayer.controls = true;
        videoPlayer.webkitEnterFullscreen();
      } catch {
        videoPlayerStatus.textContent = "Could not enter fullscreen. You can keep watching in the expanded player.";
      }
    } else {
      videoPlayerStatus.textContent = "Could not enter fullscreen. You can keep watching in the expanded player.";
    }
  }
  syncFullscreenState();
}

videoFullscreenToggle.addEventListener("click", toggleVideoFullscreen);
videoTheaterBack.addEventListener("click", () => closeVideoTheater());
videoTheaterClose.addEventListener("click", () => closeVideoTheater());
videoPlayer.addEventListener("click", () => {
  if (!videoTheater.open) openVideoTheater();
  else {
    revealVideoControls();
    scheduleVideoControlsHide();
  }
});
videoPlayer.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && !videoTheater.open) {
    event.preventDefault();
    openVideoTheater();
  }
});
playerTrack.addEventListener("click", () => {
  if (activePlayer === videoPlayer && !videoTheater.open) openVideoTheater();
});
videoTheater.addEventListener("pointermove", () => {
  revealVideoControls();
  scheduleVideoControlsHide();
});
videoTheater.addEventListener("pointerdown", () => {
  revealVideoControls();
  scheduleVideoControlsHide();
});
videoTheater.addEventListener("keydown", () => {
  revealVideoControls();
  scheduleVideoControlsHide();
});
videoTheater.addEventListener("focusin", revealVideoControls);
videoTheater.addEventListener("focusout", scheduleVideoControlsHide);
videoTheater.addEventListener("cancel", (event) => {
  event.preventDefault();
  void closeVideoTheater();
});
videoTheater.addEventListener("click", (event) => {
  if (event.target === videoTheater) void closeVideoTheater();
});
videoTheater.addEventListener("close", restoreVideoToPlayer);
for (const eventName of ["fullscreenchange", "webkitfullscreenchange"]) {
  document.addEventListener(eventName, () => {
    syncFullscreenState();
    if (!isVideoFullscreenActive() && videoTheater.open) scheduleVideoControlsHide();
  });
}
videoPlayer.addEventListener("webkitbeginfullscreen", () => {
  videoFullscreenNative = true;
  videoPlayer.controls = true;
  updateVideoSubtitleOverlay();
  syncFullscreenState();
});
videoPlayer.addEventListener("webkitendfullscreen", () => {
  videoFullscreenNative = false;
  videoPlayer.controls = false;
  updateVideoSubtitleOverlay();
  syncFullscreenState();
  sampleVideoProgress(true);
  if (videoTheater.open) scheduleVideoControlsHide();
});
window.addEventListener("popstate", () => {
  if (!videoTheater.open) return;
  videoHistoryEntry = false;
  videoPriorHistoryState = null;
  void closeVideoTheater({ fromHistory: true });
});
window.addEventListener("puffin:tab-changed", (event) => {
  if (event.detail !== "watch" && videoTheater.open) void closeVideoTheater();
});
window.addEventListener("pagehide", () => {
  sampleVideoProgress(true);
  if (videoHistoryEntry) {
    videoHistoryEntry = false;
    try { history.replaceState(videoPriorHistoryState, "", window.location.href); } catch { /* The document may be leaving the page. */ }
  }
  if (videoTheater.open) void closeVideoTheater({ fromHistory: true });
});

playerReveal.addEventListener("click", () => {
  if (activePlayer === videoPlayer) openVideoTheater();
  else openPlayerMode("lyrics");
});

playerDock.addEventListener("pointerenter", (event) => {
  if (event.pointerType === "mouse" && !playerCollapseRequested) setDockRevealed(true);
});
playerDock.addEventListener("pointerleave", (event) => {
  if (event.pointerType === "mouse") {
    if (!playerCollapseRequested) {
      setDockRevealed(playerPinnedOpen || playerRevealZone.matches(":hover"));
    }
  }
});
playerRevealZone.addEventListener("pointerenter", (event) => {
  if (event.pointerType === "mouse" && !playerCollapseRequested) setDockRevealed(true);
});
playerRevealZone.addEventListener("pointerleave", (event) => {
  if (event.pointerType === "mouse") {
    playerCollapseRequested = false;
    setDockRevealed(playerPinnedOpen || playerDock.matches(":hover"));
  }
});
document.addEventListener("pointermove", (event) => {
  if (event.pointerType !== "mouse" || !playerCollapseRequested) return;
  const overDock = playerDock.matches(":hover");
  const overRevealZone = playerRevealZone.matches(":hover");
  if (!overDock && !overRevealZone) playerCollapseRequested = false;
  else if (overRevealZone) {
    playerCollapseRequested = false;
    setDockRevealed(true);
  }
});
playerDock.addEventListener("focusin", () => setDockRevealed(true));
playerDock.addEventListener("focusout", (event) => {
  if (!playerDock.contains(event.relatedTarget)) setDockRevealed(playerPinnedOpen);
});

initializeDownloader();
initializeEnrichment();
installMediaSessionActions();
initializeSettings();
initializeEdit({
  onPreview: async (record) => {
    await startPlayback(record);
    return activeMediaId === record.id && activePlayer === audioPlayer && !audioPlayer.paused;
  },
});
initializeHome({
  onPlay: (record) => { playlistQueueActive = false; return startPlayback(record, 0, record.kind === "video"); },
  onPlayPlaylist: async (playlist) => {
    const records = await listMediaFiles();
    const byId = new Map(records.filter((record) => record.kind === "audio").map((record) => [record.id, record]));
    const items = playlist.mediaIds.map((id) => byId.get(id)).filter(Boolean);
    if (!items.length) { setLibraryStatus("This playlist has no songs to play."); return; }
    queueRecords = items;
    playlistQueueActive = true;
    setShuffle(true);
    await startPlayback(items[Math.floor(Math.random() * items.length)]);
  },
});
initializeDiscover({
  onFindMusic: (query) => {
    document.querySelector('[data-tab="download"]')?.click();
    window.dispatchEvent(new CustomEvent("puffin:download-pick", { detail: { query } }));
  },
  onOpenLibrary: () => {
    document.querySelector('[data-tab="play"][data-library-view="library"]')?.click();
  },
  onSearchLibrary: (query) => {
    document.querySelector('[data-tab="listen"]')?.click();
    requestAnimationFrame(() => {
      const input = document.querySelector("#listen-search");
      if (!input) return;
      input.value = query;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    });
  },
});
initializeStats();
equalizerController = initializeEqualizer({ audioPlayer, videoPlayer });
initializeWatch({ onPlay: (record, resumeTime) => startPlayback(record, resumeTime, true) });
initializeListen({ onPlay: (record) => startPlayback(record) });
window.addEventListener("online", cacheLibraryArtwork);
void cacheLibraryArtwork();

void (async () => {
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYER_STATE_KEY) || "null");
    if (!saved?.mediaId) return;
    const media = await listMediaFiles();
    const byId = new Map(media.map((record) => [record.id, record]));
    queueRecords = (Array.isArray(saved.queue) ? saved.queue : []).map((id) => byId.get(id)).filter(Boolean);
    shuffleEnabled = Boolean(saved.shuffle);
    repeatMode = [0, 1, 2].includes(saved.repeat) ? saved.repeat : 1;
    setShuffle(shuffleEnabled);
    if (repeatMode !== 1) { repeatMode = (repeatMode + 2) % 3; cycleRepeat(); }
    const record = byId.get(saved.mediaId);
    if (!record) return;
    await startPlayback(record, Math.max(0, Number(saved.time) || 0), false, false);
  } catch { /* Ignore a damaged or unavailable saved session. */ }
})();

if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.error("Puffin could not register its offline app worker:", error);
    });
  });
}
