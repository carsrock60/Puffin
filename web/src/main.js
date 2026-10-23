import { getMediaBlob } from "./library.js";
import { initializeDownloader } from "./downloader.js";
import { initializePlaylistLibrary } from "./playlist-library.js";
import { initializeSettings } from "./settings.js";

const tabButtons = document.querySelectorAll("[data-tab]");
const panels = document.querySelectorAll("[data-panel]");
const homePanel = document.querySelector("#home-panel");

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

    homePanel.hidden = true;
  });
});

const themeToggle = document.querySelector("#theme-toggle");
themeToggle.addEventListener("click", () => {
  const isDark = document.body.classList.toggle("dark");
  themeToggle.setAttribute("aria-pressed", String(isDark));
});

const libraryStatus = document.querySelector("#library-status");
const playerRevealZone = document.querySelector("#player-reveal-zone");
const playerRevealZoneHome = playerRevealZone.parentElement;
const playerDock = document.querySelector("#player-dock");
const playerDockHome = playerDock.parentElement;
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
const playerVolume = document.querySelector("#player-volume");
const playerSpeed = document.querySelector("#player-speed");
const playerClose = document.querySelector("#player-close");
const videoTheater = document.querySelector("#video-theater");
const videoTheaterStage = document.querySelector("#video-theater-stage");
const playerTrack = document.querySelector(".player-track");

let activeMediaId = null;
let activeObjectUrl = null;
let activePlayer = null;
let isSeeking = false;
let playerPinnedOpen = false;
let playerCollapseRequested = false;
let playerPinnedOpenBeforeTheater = false;

function setDockRevealed(revealed) {
  playerDock.classList.toggle("is-revealed", revealed);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
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
}

function setLibraryStatus(message) {
  libraryStatus.textContent = message;
}

async function startPlayback(record) {
  try {
    const blob = await getMediaBlob(record.id);
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
    playerCollapseRequested = false;
    playerPinnedOpen = true;
    playerReveal.setAttribute("aria-expanded", "true");
    playerReveal.setAttribute("aria-label", "Hide player controls");
    playerReveal.title = "Hide player controls";
    currentMediaTitle.textContent = record.name;
    playerDock.hidden = false;
    mediaPlayer.hidden = false;

    const player = record.kind === "video" ? videoPlayer : audioPlayer;
    const otherPlayer = player === videoPlayer ? audioPlayer : videoPlayer;
    otherPlayer.hidden = true;
    player.hidden = false;
    player.src = activeObjectUrl;
    player.volume = Number(playerVolume.value);
    player.playbackRate = 1;
    player.defaultPlaybackRate = 1;
    playerSpeed.value = "1";
    activePlayer = player;
    playerArtwork.hidden = record.kind === "video";
    setDockRevealed(true);
    playerSubtitle.textContent = record.kind === "video" ? "Video · Puffin Library" : "Puffin Library";
    document.body.classList.add("has-player");
    updatePlayerControls();

    try {
      await player.play();
      updatePlayerControls();
      setLibraryStatus(`Playing ${record.name}`);
    } catch (error) {
      updatePlayerControls();
      setLibraryStatus(`${getPlaybackErrorMessage(player, error)} Track: ${record.name}.`);
    }
  } catch (error) {
    setLibraryStatus(`Could not open this file: ${error.message}`);
  }
}

function stopPlayback() {
  if (videoTheater.open) videoTheater.close();
  audioPlayer.pause();
  videoPlayer.pause();
  audioPlayer.removeAttribute("src");
  videoPlayer.removeAttribute("src");
  audioPlayer.load();
  videoPlayer.load();
  if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
  activeObjectUrl = null;
  activeMediaId = null;
  activePlayer = null;
  isSeeking = false;
  mediaPlayer.hidden = true;
  playerDock.hidden = true;
  playerPinnedOpen = false;
  playerCollapseRequested = false;
  setDockRevealed(false);
  playerReveal.setAttribute("aria-expanded", "false");
  playerReveal.setAttribute("aria-label", "Show player controls");
  playerReveal.title = "Show player controls";
  playerArtwork.hidden = false;
  playerSubtitle.textContent = "Puffin Library";
  document.body.classList.remove("has-player");
  updatePlayerControls();
}

initializePlaylistLibrary({
  onPlay: startPlayback,
  onDeleted: (record) => {
    if (activeMediaId === record.id) stopPlayback();
  },
});

for (const player of [audioPlayer, videoPlayer]) {
  for (const eventName of ["loadedmetadata", "durationchange", "timeupdate", "play", "pause", "ended"]) {
    player.addEventListener(eventName, updatePlayerControls);
  }
  player.addEventListener("error", () => {
    setLibraryStatus(getPlaybackErrorMessage(player));
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

playerVolume.addEventListener("input", () => {
  const volume = Number(playerVolume.value);
  audioPlayer.volume = volume;
  videoPlayer.volume = volume;
});

playerSpeed.addEventListener("change", () => {
  const speed = Number(playerSpeed.value);
  audioPlayer.playbackRate = speed;
  videoPlayer.playbackRate = speed;
});

playerClose.addEventListener("click", stopPlayback);

playerReveal.addEventListener("click", () => {
  playerPinnedOpen = !playerPinnedOpen;
  playerCollapseRequested = !playerPinnedOpen;
  setDockRevealed(playerPinnedOpen);
  playerReveal.setAttribute("aria-expanded", String(playerPinnedOpen));
  playerReveal.setAttribute("aria-label", playerPinnedOpen ? "Hide player controls" : "Show player controls");
  playerReveal.title = playerPinnedOpen ? "Hide player controls" : "Show player controls";
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

function openVideoTheater() {
  if (activePlayer !== videoPlayer || videoTheater.open) return;
  videoPlayer.setAttribute("aria-label", "Playing video");
  videoPlayer.controls = false;
  playerPinnedOpenBeforeTheater = playerPinnedOpen;
  playerPinnedOpen = false;
  playerCollapseRequested = false;
  playerReveal.setAttribute("aria-expanded", "false");
  playerReveal.setAttribute("aria-label", "Show player controls");
  playerReveal.title = "Show player controls";
  setDockRevealed(false);
  videoTheaterStage.append(videoPlayer);
  videoTheater.append(playerRevealZone);
  videoTheater.append(playerDock);
  videoTheater.showModal();
}

function restoreVideoToPlayer() {
  if (videoPlayer.parentElement !== playerTrack) {
    playerTrack.insertBefore(videoPlayer, playerTrack.querySelector(".player-track-copy"));
  }
  videoPlayer.controls = false;
  videoPlayer.setAttribute("aria-label", "Expand video");
  playerRevealZoneHome.append(playerRevealZone);
  playerDockHome.append(playerDock);
  playerPinnedOpen = playerPinnedOpenBeforeTheater;
  playerReveal.setAttribute("aria-expanded", String(playerPinnedOpen));
  playerReveal.setAttribute("aria-label", playerPinnedOpen ? "Hide player controls" : "Show player controls");
  playerReveal.title = playerPinnedOpen ? "Hide player controls" : "Show player controls";
  setDockRevealed(playerPinnedOpen || playerDock.matches(":hover") || playerRevealZone.matches(":hover"));
}

videoPlayer.addEventListener("click", openVideoTheater);
videoPlayer.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openVideoTheater();
  }
});
videoTheater.addEventListener("click", (event) => {
  if (event.target === videoTheater) videoTheater.close();
});
videoTheater.addEventListener("close", restoreVideoToPlayer);

initializeDownloader();
initializeSettings();

if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.error("Puffin could not register its offline app worker:", error);
    });
  });
}
