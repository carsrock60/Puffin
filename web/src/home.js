import { getMediaDisplayTitle, listRecentlyPlayed, listPlaylists } from "./library.js";
import { getHomePreferences } from "./home-preferences.js";
import { inView } from "motion";
import { animateElement, MOTION_EASE, prefersReducedMotion } from "./motion.js";

export function initializeHome({ onPlay, onPlayPlaylist }) {
  const recentSection = document.querySelector("#recently-played-section");
  const recentList = document.querySelector("#recently-played-list");
  const recentEmpty = document.querySelector("#recently-played-empty");
  const previous = document.querySelector("#recent-scroll-left");
  const next = document.querySelector("#recent-scroll-right");

  async function refreshPlaylists() {
    const playlists = await listPlaylists();
    const list = document.querySelector("#quick-play-list");
    document.querySelector("#quick-play-empty").hidden = playlists.length > 0;
    list.replaceChildren(...playlists.map((playlist) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "quick-play-card";
      button.setAttribute("aria-label", `Shuffle ${playlist.name}`);
      const image = document.createElement("img");
      image.src = playlist.artwork || "/favicon.svg";
      image.alt = "";
      image.onerror = () => { image.onerror = null; image.src = "/favicon.svg"; };
      const title = document.createElement("span");
      title.textContent = playlist.name;
      button.append(image, title);
      button.addEventListener("click", () => onPlayPlaylist(playlist));
      item.append(button);
      return item;
    }));
  }

  window.addEventListener("puffin:playlists-updated", () => { refreshPlaylists().catch(() => {}); });
  window.addEventListener("puffin:library-view", () => { refreshPlaylists().catch(() => {}); });
  refreshPlaylists().catch(() => {});

  function updateScrollButtons() {
    const canScroll = !recentList.hidden && recentList.scrollWidth > recentList.clientWidth + 2;
    previous.disabled = !canScroll || recentList.scrollLeft <= 1;
    next.disabled = !canScroll || recentList.scrollLeft + recentList.clientWidth >= recentList.scrollWidth - 2;
  }

  function renderRecentlyPlayed(records) {
    recentList.replaceChildren();
    records.forEach((record) => {
      const title = getMediaDisplayTitle(record);
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

  function applyPreferences(preferences = getHomePreferences()) {
    recentSection.hidden = !preferences.showRecentlyPlayed;
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

  const revealedSections = new WeakSet();
  function setupHomeSectionReveals() {
    const sections = [...document.querySelectorAll("#home-panel .home-section")];
    sections.forEach((section, index) => {
      if (revealedSections.has(section)) return;
      if (prefersReducedMotion()) {
        revealedSections.add(section);
        return;
      }
      section.classList.add("is-reveal-pending");
      let stop = null;
      stop = inView(section, () => {
        stop?.();
        revealedSections.add(section);
        if (prefersReducedMotion()) {
          section.classList.remove("is-reveal-pending");
          return;
        }
        const controls = animateElement(section, { opacity: [0, 1], y: [10, 0] }, {
          duration: 0.46,
          delay: Math.min(index * 0.05, 0.15),
          ease: MOTION_EASE,
        });
        if (!controls) {
          section.classList.remove("is-reveal-pending");
          return;
        }
        controls.finished.then(() => {
          section.classList.remove("is-reveal-pending");
          section.style.opacity = "";
          section.style.transform = "";
        }).catch(() => { /* A later render replaced the section. */ });
      }, { amount: 0.12 });
    });
  }

  previous.addEventListener("click", () => recentList.scrollBy({ left: -recentList.clientWidth * 0.8, behavior: "smooth" }));
  next.addEventListener("click", () => recentList.scrollBy({ left: recentList.clientWidth * 0.8, behavior: "smooth" }));
  recentList.addEventListener("scroll", updateScrollButtons, { passive: true });
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
  setupHomeSectionReveals();
}
