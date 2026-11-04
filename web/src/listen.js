import { listMediaFiles, listPlaylists, listRecentlyPlayed } from "./library.js";

export function initializeListen({ onPlay }) {
  const featured = document.querySelector("#listen-featured");
  const recent = document.querySelector("#listen-recent");
  const recentEmpty = document.querySelector("#listen-recent-empty");
  const library = document.querySelector("#listen-library");
  const empty = document.querySelector("#listen-empty");
  const search = document.querySelector("#listen-search");
  const playlistSelect = document.querySelector("#listen-playlist");
  let songs = [];
  let recentSongs = [];
  let playlists = [];

  const titleOf = (song) => song.title || song.name.replace(/\.[^.]+$/, "");
  const artworkFor = (song, className) => {
    const img = document.createElement("img");
    img.className = className;
    img.src = song.artwork || "/favicon.svg";
    img.alt = "";
    img.loading = "lazy";
    img.addEventListener("error", () => { if (!img.src.endsWith("/favicon.svg")) img.src = "/favicon.svg"; }, { once: true });
    return img;
  };
  const makeRow = (song, compact = false) => {
    const card = document.createElement("article");
    card.className = compact ? "watch-video-card watch-video-card-compact" : "watch-video-card";
    card.setAttribute("role", "listitem");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "watch-thumbnail-button listen-art-button";
    button.setAttribute("aria-label", `Play ${titleOf(song)}`);
    const art = artworkFor(song, "listen-artwork");
    const play = document.createElement("span");
    play.className = "watch-thumbnail-mark";
    play.textContent = "▶";
    button.append(art, play);
    button.addEventListener("click", () => onPlay(song));
    const title = document.createElement("button");
    title.type = "button";
    title.className = "watch-video-title-button";
    const heading = document.createElement("h3");
    heading.textContent = titleOf(song);
    title.append(heading);
    title.addEventListener("click", () => onPlay(song));
    const metadata = document.createElement("p");
    metadata.className = "watch-video-metadata";
    metadata.textContent = [song.artist, song.album].filter(Boolean).join(" · ") || "Puffin Library";
    card.append(button, title, metadata);
    return card;
  };

  function render() {
    recent.replaceChildren(...recentSongs.slice(0, 12).map((song) => makeRow(song, true)));
    recentEmpty.hidden = recentSongs.length > 0;
    const latest = recentSongs[0] || songs[0];
    featured.replaceChildren();
    if (latest) {
      const hero = document.createElement("article");
      hero.className = "watch-featured-card listen-featured-card";
      const art = artworkFor(latest, "watch-featured-art");
      const copy = document.createElement("div");
      copy.className = "watch-featured-copy";
      const eyebrow = document.createElement("p");
      eyebrow.className = "watch-eyebrow";
      eyebrow.textContent = recentSongs.length ? "PICK UP THE MUSIC" : "YOUR MUSIC LIBRARY";
      const heading = document.createElement("h2");
      heading.textContent = titleOf(latest);
      const byline = document.createElement("p");
      byline.className = "watch-featured-metadata";
      byline.textContent = [latest.artist, latest.album].filter(Boolean).join(" · ");
      const play = document.createElement("button");
      play.type = "button";
      play.className = "primary-button watch-featured-play";
      play.textContent = "Play";
      play.addEventListener("click", () => onPlay(latest));
      copy.append(eyebrow, heading, byline, play);
      hero.append(art, copy);
      featured.append(hero);
    }
    const query = search.value.toLocaleLowerCase().trim();
    const selected = playlists.find((item) => item.id === playlistSelect.value);
    const selectedIds = selected ? new Set(selected.mediaIds) : null;
    const filtered = songs.filter((song) => {
      if (selectedIds && !selectedIds.has(song.id)) return false;
      return !query || [titleOf(song), song.artist, song.album, song.genre].join(" ").toLocaleLowerCase().includes(query);
    });
    library.replaceChildren(...filtered.map((song) => makeRow(song)));
    empty.hidden = filtered.length > 0;
  }

  async function load() {
    const [records, playlistsNext, recentNext] = await Promise.all([listMediaFiles(), listPlaylists(), listRecentlyPlayed()]);
    songs = records.filter((record) => record.kind === "audio");
    playlists = playlistsNext.filter((playlist) => playlist.mediaIds.some((id) => songs.some((song) => song.id === id)));
    recentSongs = recentNext.filter((record) => record.kind === "audio");
    const oldValue = playlistSelect.value;
    playlistSelect.replaceChildren(new Option("All playlists", "all"));
    playlists.forEach((playlist) => playlistSelect.add(new Option(playlist.name, playlist.id)));
    playlistSelect.value = playlists.some((playlist) => playlist.id === oldValue) ? oldValue : "all";
    render();
  }
  search.addEventListener("input", render);
  playlistSelect.addEventListener("change", render);
  window.addEventListener("puffin:library-updated", load);
  window.addEventListener("puffin:metadata-updated", load);
  window.addEventListener("puffin:recently-played-updated", load);
  window.addEventListener("puffin:tab-changed", (event) => { if (event.detail === "listen") load(); });
  load();
}
