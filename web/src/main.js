import { getMediaBlob, listMediaFiles, recordMediaPlay, recordListeningTime, recordVideoWatchProgress } from "./library.js";
import { initializeDownloader } from "./downloader.js";
import { initializePlaylistLibrary } from "./playlist-library.js";
import { initializeSettings } from "./settings.js";
import { initializeEdit } from "./edit.js";
import { initializeHome } from "./home.js";
import { initializeStats } from "./stats.js";
import { initializeEqualizer } from "./equalizer.js";
import { initializeWatch } from "./watch.js";
import { initializeListen } from "./listen.js";
import { renderSyncedLyrics, syncSyncedLyrics } from "./lyrics.js";

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
const fullPlayerVisualizer = document.querySelector("#full-player-visualizer");
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
let shuffleEnabled = false;
let repeatMode = 1;
let playerPane = "lyrics";
let playerModeCloseTimer;
let playerModeReturnFocus = null;
let visualizerEnabled = false;
let visualizerAnalyser = null;
let visualizerData = null;
let visualizerFrame = 0;
let lyricsSyncFrame = 0;
let equalizerController = null;
let dragQueueId = null;
let queueHoldTimer;
const visualizerBars = Array.from({ length: 24 }, () => {
  const bar = document.createElement("span");
  bar.setAttribute("aria-hidden", "true");
  return bar;
});
fullPlayerVisualizer.replaceChildren(...visualizerBars);

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
    if (window.matchMedia("(max-width: 720px)").matches) closeMobileSidebar({ restoreFocus: true });
  });
});

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

const themeToggle = document.querySelector("#theme-toggle");
themeToggle.addEventListener("click", () => {
  const isDark = document.body.classList.toggle("dark");
  themeToggle.setAttribute("aria-pressed", String(isDark));
});

const libraryStatus = document.querySelector("#library-status");
const playerRevealZone = document.querySelector("#player-reveal-zone");
const playerDock = document.querySelector("#player-dock");
const mediaPlayer = document.querySelector("#media-player");
const playerReveal = document.querySelector("#player-reveal");
const currentMediaTitle = document.querySelector("#current-media-title");
const audioPlayer = document.querySelector("#audio-player");
const videoPlayer = document.querySelector("#video-player");
const playerArtwork = document.querySelector("#player-artwork");
const playerSubtitle = document.querySelector("#player-subtitle");
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
const videoFullscreenToggle = document.querySelector("#video-fullscreen-toggle");
const videoPlayerStatus = document.querySelector("#video-player-status");
const videoTheaterControls = document.querySelector("#video-theater-controls");
const playerVideoFallback = document.querySelector("#player-video-fallback");
const playerTrack = document.querySelector(".player-track");
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
  if (visualizerFrame) cancelAnimationFrame(visualizerFrame);
  visualizerFrame = 0;
}

function startVisualizerLoop() {
  if (visualizerFrame || !visualizerEnabled || !visualizerAnalyser || playerPane !== "lyrics"
    || playerFullscreen.hidden || activePlayer !== audioPlayer || audioPlayer.paused || audioPlayer.ended) return;
  const draw = () => {
    visualizerFrame = 0;
    if (!visualizerEnabled || !visualizerAnalyser || playerPane !== "lyrics"
      || playerFullscreen.hidden || activePlayer !== audioPlayer || audioPlayer.paused || audioPlayer.ended) return;
    visualizerAnalyser.getByteFrequencyData(visualizerData);
    const binWidth = visualizerAnalyser.context.sampleRate / visualizerAnalyser.fftSize;
    const lowestFrequency = 45;
    const highestFrequency = Math.min(12000, visualizerAnalyser.context.sampleRate / 2);
    visualizerBars.forEach((bar, index) => {
      const startFrequency = lowestFrequency * (highestFrequency / lowestFrequency) ** (index / visualizerBars.length);
      const endFrequency = lowestFrequency * (highestFrequency / lowestFrequency) ** ((index + 1) / visualizerBars.length);
      const firstBin = Math.max(1, Math.floor(startFrequency / binWidth));
      const lastBin = Math.min(visualizerData.length, Math.max(firstBin + 1, Math.ceil(endFrequency / binWidth)));
      let energy = 0;
      for (let bin = firstBin; bin < lastBin; bin += 1) energy += visualizerData[bin];
      const average = energy / Math.max(1, lastBin - firstBin);
      const level = Math.max(0.06, Math.min(1, (average / 255) ** 0.8 * 1.65));
      bar.style.setProperty("--level", level.toFixed(2));
    });
    visualizerFrame = requestAnimationFrame(draw);
  };
  visualizerFrame = requestAnimationFrame(draw);
}

function setVisualizerEnabled(enabled) {
  visualizerEnabled = enabled;
  fullPlayerVisualizer.hidden = !enabled;
  playerVisualizer.setAttribute("aria-pressed", String(enabled));
  document.querySelector("#full-player-visualizer-button").setAttribute("aria-pressed", String(enabled));
  if (enabled) startVisualizerLoop();
  else {
    stopVisualizerLoop();
    visualizerBars.forEach((bar) => bar.style.setProperty("--level", ".06"));
  }
}

async function toggleVisualizer() {
  if (activeMediaRecord?.kind !== "audio") return;
  if (playerFullscreen.hidden) openPlayerMode("lyrics");
  else if (playerPane !== "lyrics") setPlayerPane("lyrics");
  if (visualizerEnabled) {
    setVisualizerEnabled(false);
    return;
  }
  setVisualizerEnabled(true);
  const status = document.querySelector("#full-player-visualizer-status");
  status.hidden = true;
  try {
    visualizerAnalyser = await equalizerController.getAnalyser(audioPlayer);
    if (!visualizerAnalyser) throw new Error("Audio analysis is unavailable in this browser.");
    visualizerData = new Uint8Array(visualizerAnalyser.frequencyBinCount);
    startVisualizerLoop();
  } catch (error) {
    if (!visualizerEnabled) return;
    setVisualizerEnabled(false);
    status.textContent = `Visualizer could not start: ${error.message}`;
    status.hidden = false;
  }
}

function setPlayerPane(pane) {
  if (pane !== "lyrics") setVisualizerEnabled(false);
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

function openPlayerMode(pane = "lyrics") {
  if (!activeMediaRecord || activeMediaRecord.kind !== "audio") return;
  window.clearTimeout(playerModeCloseTimer);
  if (playerFullscreen.hidden) playerModeReturnFocus = document.activeElement;
  playerFullscreen.hidden = false;
  playerFullscreen.inert = false;
  playerFullscreen.setAttribute("aria-hidden", "false");
  playerFullscreen.classList.add("is-closing");
  requestAnimationFrame(() => requestAnimationFrame(() => playerFullscreen.classList.remove("is-closing")));
  fullPlayerTitle.textContent = activeMediaRecord.title || activeMediaRecord.name.replace(/\.[^.]+$/, "");
  fullPlayerArtist.textContent = activeMediaRecord.artist || "Puffin Library";
  fullPlayerArtwork.src = activeMediaRecord.artwork || "/favicon.svg";
  setPlayerPane(pane);
  updateFullPlayerControls();
  setPlayerRevealState(true);
  document.querySelector("#full-player-back").focus({ preventScroll: true });
}

function closePlayerMode() {
  if (playerFullscreen.hidden) return;
  setPlayerPane("lyrics");
  setVisualizerEnabled(false);
  playerFullscreen.classList.add("is-closing");
  playerFullscreen.inert = true;
  playerFullscreen.setAttribute("aria-hidden", "true");
  setPlayerRevealState(false);
  window.clearTimeout(playerModeCloseTimer);
  playerModeCloseTimer = window.setTimeout(() => {
    playerFullscreen.hidden = true;
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
    handle.setAttribute("aria-label", `Reorder ${record.title || record.name}. Hold and drag, or use the arrow keys.`);
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      window.clearTimeout(queueHoldTimer);
      queueHoldTimer = window.setTimeout(() => { dragQueueId = record.id; handle.classList.add("is-dragging"); row.classList.add("is-dragging"); }, 240);
    });
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const index = queueRecords.findIndex((item) => item.id === record.id);
      const destination = Math.max(0, Math.min(queueRecords.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
      if (destination === index) return;
      const [item] = queueRecords.splice(index, 1);
      queueRecords.splice(destination, 0, item);
      renderPlayerQueue();
      [...fullPlayerQueueList.querySelectorAll("li[data-queue-id]")]
        .find((queueRow) => queueRow.dataset.queueId === record.id)
        ?.querySelector(".queue-drag-handle")?.focus({ preventScroll: true });
    });
    const art = document.createElement("img");
    art.className = "queue-row-art";
    art.src = record.artwork || "/favicon.svg";
    art.alt = "";
    const title = document.createElement("span");
    title.className = "queue-row-title";
    title.textContent = `${record.title || record.name.replace(/\.[^.]+$/, "")} · ${record.artist || "Unknown artist"}`;
    const play = document.createElement("button");
    play.type = "button";
    play.className = "queue-row-play";
    play.textContent = record.id === activeMediaId ? "Playing" : "Play";
    play.disabled = record.id === activeMediaId;
    play.addEventListener("click", () => startPlayback(record));
    row.append(handle, art, title, play);
    fullPlayerQueueList.append(row);
  });
}

async function prepareQueue(record) {
  if (record.kind !== "audio") return;
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
  if (!dragQueueId) return;
  const from = queueRecords.findIndex((record) => record.id === dragQueueId);
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("li[data-queue-id]");
  const to = target ? queueRecords.findIndex((record) => record.id === target.dataset.queueId) : -1;
  if (from < 0 || to < 0 || from === to) return;
  const [record] = queueRecords.splice(from, 1);
  queueRecords.splice(to, 0, record);
  renderPlayerQueue();
});
function finishQueueDrag() {
  window.clearTimeout(queueHoldTimer);
  if (dragQueueId) {
    dragQueueId = null;
    document.querySelectorAll(".queue-drag-handle.is-dragging, .full-player-queue-list li.is-dragging").forEach((element) => element.classList.remove("is-dragging"));
    renderPlayerQueue();
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
  if (visualizerEnabled && playing && activePlayer === audioPlayer) startVisualizerLoop();
  else stopVisualizerLoop();
  updateFullPlayerControls();
  updateVideoTheaterControls();
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
  videoTheaterTitle.textContent = activeMediaRecord?.title || activeMediaRecord?.name?.replace(/\.[^.]+$/, "") || "Now playing";
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

async function startPlayback(record, startTime = 0, openVideo = false) {
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
    if (record.kind === "video" && !playerFullscreen.hidden) closePlayerMode();
    void prepareQueue(record);
    renderPlayerQueue();
    if (playerFullscreen && !playerFullscreen.hidden && record.kind === "audio") {
      fullPlayerTitle.textContent = record.title || record.name.replace(/\.[^.]+$/, "");
      fullPlayerArtist.textContent = record.artist || "Puffin Library";
      fullPlayerArtwork.src = record.artwork || "/favicon.svg";
      renderPlayerLyrics(record);
    }
    lastVideoProgressSecond = -1;
    playerCollapseRequested = false;
    playerPinnedOpen = true;
    setPlayerRevealState(false);
    currentMediaTitle.textContent = record.title || record.name.replace(/\.[^.]+$/, "");
    playerSubtitle.textContent = record.artist || "Puffin Library";
    const isVideo = record.kind === "video";
    [playerShuffle, playerRepeat, playerVisualizer, playerQueue].forEach((button) => { button.disabled = isVideo; });
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
    player.src = activeObjectUrl;
    player.playbackRate = 1;
    player.defaultPlaybackRate = 1;
    playerSpeed.value = "1";
    activePlayer = player;
    setPlayerRevealState(false);
    setDockRevealed(true);
    playerSubtitle.textContent = record.kind === "video" ? `Video · ${record.artist || "Puffin Library"}` : "Puffin Library";
    document.body.classList.add("has-player");
    if (player === videoPlayer && startTime > 0) {
      const resume = () => {
        if (activeMediaId === record.id && Number.isFinite(videoPlayer.duration)) {
          videoPlayer.currentTime = Math.min(startTime, Math.max(0, videoPlayer.duration - 0.25));
        }
      };
      if (videoPlayer.readyState >= 1) resume();
      else videoPlayer.addEventListener("loadedmetadata", resume, { once: true });
    }
    if (player === videoPlayer && openVideo) openVideoTheater();
    updatePlayerControls();

    try {
      await player.play();
      recordMediaPlay(record.id).catch((error) => console.warn("Could not update recent plays:", error));
      updatePlayerControls();
      setLibraryStatus(`Playing ${record.name}`);
      if (player === videoPlayer) sampleVideoProgress(true);
    } catch (error) {
      updatePlayerControls();
      const message = `${getPlaybackErrorMessage(player, error)} Track: ${record.name}.`;
      setLibraryStatus(message);
      if (player === videoPlayer) videoPlayerStatus.textContent = getPlaybackErrorMessage(player, error);
    }
  } catch (error) {
    setLibraryStatus(`Could not open this file: ${error.message}`);
  }
}

async function stopPlayback() {
  playbackRequestId += 1;
  closePlayerMode();
  if (activePlayer === videoPlayer) sampleVideoProgress(true);
  sampleListeningTime(activePlayer);
  audioPlayer.pause();
  videoPlayer.pause();
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
  [playerShuffle, playerRepeat, playerVisualizer, playerQueue].forEach((button) => { button.disabled = true; });
  document.querySelector("#player-equalizer-open").disabled = true;
  playerTrack.classList.remove("is-video");
  playerSubtitle.textContent = "Puffin Library";
  document.body.classList.remove("has-player");
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
  const queuedRecord = queueRecords.find((item) => item.id === record.id);
  if (queuedRecord) Object.assign(queuedRecord, record);
  if (record.id !== activeMediaId) return;
  currentMediaTitle.textContent = record.title || record.name.replace(/\.[^.]+$/, "");
  playerSubtitle.textContent = record.kind === "video" ? `Video · ${record.artist || "Puffin Library"}` : (record.artist || "Puffin Library");
  if (playerFullscreen && !playerFullscreen.hidden && record.kind === "audio") {
    fullPlayerTitle.textContent = record.title || record.name.replace(/\.[^.]+$/, "");
    fullPlayerArtist.textContent = record.artist || "Puffin Library";
    fullPlayerArtwork.src = record.artwork || "/favicon.svg";
    renderPlayerLyrics(record);
  }
  activeMediaRecord = record;
  if (record.artwork) playerArtwork.src = record.artwork;
  playerArtwork.hidden = record.kind === "video" && !record.artwork;
  playerVideoFallback.hidden = record.kind !== "video" || Boolean(record.artwork);
  playerExpandVideo.hidden = record.kind !== "video";
  if (videoTheater.open) {
    videoTheaterTitle.textContent = record.title || record.name.replace(/\.[^.]+$/, "");
    videoTheaterSubtitle.textContent = [record.artist, record.album].filter(Boolean).join(" · ") || "Puffin video library";
  }
});

for (const player of [audioPlayer, videoPlayer]) {
  for (const eventName of ["loadedmetadata", "durationchange", "timeupdate", "play", "pause", "ended"]) {
    player.addEventListener(eventName, updatePlayerControls);
  }
  player.addEventListener("play", () => {
    if (player === activePlayer && player === audioPlayer) {
      playbackSample = { wallTime: performance.now(), position: player.currentTime };
      startLyricsSyncLoop();
    }
  });
  player.addEventListener("timeupdate", () => sampleListeningTime(player));
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
    setLibraryStatus(message);
    if (player === videoPlayer) videoPlayerStatus.textContent = message;
  });
}

playerToggle.addEventListener("click", async () => {
  if (!activePlayer) return;
  if (activePlayer.paused) {
    try {
      await activePlayer.play();
    } catch (error) {
      setLibraryStatus(getPlaybackErrorMessage(activePlayer, error));
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
    if (visualizerEnabled) startVisualizerLoop();
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
function setShuffle(enabled) {
  shuffleEnabled = enabled;
  [playerShuffle, document.querySelector("#full-player-shuffle")].forEach((button) => button.setAttribute("aria-pressed", String(enabled)));
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
}
playerShuffle.addEventListener("click", () => setShuffle(!shuffleEnabled));
document.querySelector("#full-player-shuffle").addEventListener("click", () => setShuffle(!shuffleEnabled));
playerRepeat.addEventListener("click", cycleRepeat);
document.querySelector("#full-player-repeat").addEventListener("click", cycleRepeat);
playerVisualizer.addEventListener("click", toggleVisualizer);
playerQueue.addEventListener("click", async () => {
  if (activeMediaRecord?.kind !== "audio") return;
  if (!playerFullscreen.hidden && playerPane === "queue") { setPlayerPane("lyrics"); return; }
  await prepareQueue(activeMediaRecord);
  if (playerFullscreen.hidden) openPlayerMode("queue");
  else setPlayerPane("queue");
});
document.querySelector("#full-player-visualizer-button").addEventListener("click", toggleVisualizer);
document.querySelector("#full-player-queue-button").addEventListener("click", async () => {
  if (playerPane === "queue") { setPlayerPane("lyrics"); return; }
  if (activeMediaRecord) await prepareQueue(activeMediaRecord);
  setPlayerPane("queue");
});
document.querySelector("#full-player-eq-button").addEventListener("click", () => {
  setPlayerPane(playerPane === "equalizer" ? "lyrics" : "equalizer");
});
document.querySelector("#full-player-back").addEventListener("click", closePlayerMode);
document.querySelector("#full-player-toggle").addEventListener("click", async () => {
  if (!activePlayer) return;
  if (activePlayer.paused) { try { await activePlayer.play(); } catch {} }
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
  if (pane === "visualizer") { toggleVisualizer(); return; }
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
    try { await videoPlayer.play(); }
    catch (error) { videoPlayerStatus.textContent = getPlaybackErrorMessage(videoPlayer, error); }
  } else videoPlayer.pause();
  revealVideoControls();
  updatePlayerControls();
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
  syncFullscreenState();
});
videoPlayer.addEventListener("webkitendfullscreen", () => {
  videoFullscreenNative = false;
  videoPlayer.controls = false;
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
initializeSettings();
initializeEdit({
  onPreview: async (record) => {
    await startPlayback(record);
    return activeMediaId === record.id && activePlayer === audioPlayer && !audioPlayer.paused;
  },
});
initializeHome({ onPlay: (record) => startPlayback(record, 0, record.kind === "video") });
initializeStats();
equalizerController = initializeEqualizer({ audioPlayer, videoPlayer });
initializeWatch({ onPlay: (record, resumeTime) => startPlayback(record, resumeTime, true) });
initializeListen({ onPlay: (record) => startPlayback(record) });

if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.error("Puffin could not register its offline app worker:", error);
    });
  });
}
