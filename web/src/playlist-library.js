import {
  addMediaToPlaylist,
  createPlaylist,
  deleteMediaFile,
  deletePlaylist,
  getMediaBlob,
  getMediaStorageLimit,
  listMediaFiles,
  listPlaylists,
  removeMediaFromPlaylist,
  renamePlaylist,
  setPlaylistPinned,
} from "./library.js";

const ICONS = {
  play: "▶",
  add: "+",
  remove: "−",
  delete: "×",
};

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function iconButton(label, icon, className, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.setAttribute("aria-label", label);
  button.title = label;
  const glyph = document.createElement("span");
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = icon;
  button.append(glyph);
  button.addEventListener("click", action);
  return button;
}

export function initializePlaylistLibrary({ onPlay, onDeleted }) {
  const playPanel = document.querySelector("#play-panel");
  const libraryStatus = document.querySelector("#library-status");
  const libraryStorage = document.querySelector("#library-storage");
  const mediaList = document.querySelector("#media-list");
  const playlistList = document.querySelector("#playlist-list");
  const playlistBrowser = document.querySelector("#playlist-browser");
  const libraryLayout = document.querySelector("#playlist-library-layout");
  const pinnedNav = document.querySelector("#sidebar-pinned-playlists");
  const createPlaylistButton = document.querySelector("#create-playlist");
  const viewEyebrow = document.querySelector("#playlist-eyebrow");
  const viewTitle = document.querySelector("#playlist-view-title");
  const viewCount = document.querySelector("#playlist-view-count");
  const viewActions = document.querySelector("#playlist-view-actions");

  const dialog = document.querySelector("#playlist-dialog");
  const dialogForm = document.querySelector("#playlist-dialog-form");
  const dialogTitle = document.querySelector("#playlist-dialog-title");
  const dialogDescription = document.querySelector("#playlist-dialog-description");
  const nameField = document.querySelector("#playlist-name-field");
  const nameInput = document.querySelector("#playlist-name-input");
  const selectField = document.querySelector("#playlist-select-field");
  const playlistSelect = document.querySelector("#playlist-select");
  const cancelDialogButton = document.querySelector("#playlist-dialog-cancel");
  const submitDialogButton = document.querySelector("#playlist-dialog-submit");

  let mediaRecords = [];
  let playlists = [];
  let activeView = "all";
  let mediaKindFilter = null;
  let currentLibraryView = "library";
  let dialogAction = null;

  function setStatus(message) {
    libraryStatus.textContent = message;
  }

  async function updateStorageSummary() {
    const libraryBytes = mediaRecords.reduce((total, record) => total + record.size, 0);
    if (!navigator.storage?.estimate) {
      libraryStorage.textContent = `${mediaRecords.length} ${mediaRecords.length === 1 ? "file" : "files"} · ${formatBytes(libraryBytes)} in your library`;
      return;
    }

    try {
      const { usage, quota } = await navigator.storage.estimate();
      const browserUsage = Number.isFinite(usage) ? formatBytes(usage) : "unknown";
      const browserQuota = Number.isFinite(quota) ? formatBytes(quota) : "unknown";
      libraryStorage.textContent = `${mediaRecords.length} ${mediaRecords.length === 1 ? "file" : "files"} · ${formatBytes(libraryBytes)} in your library · ${browserUsage} of ${browserQuota} browser storage used`;
    } catch {
      libraryStorage.textContent = `${mediaRecords.length} ${mediaRecords.length === 1 ? "file" : "files"} · ${formatBytes(libraryBytes)} in your library`;
    }
  }

  function showDialog({ title, description = "", name = "", nameVisible = false, selectVisible = false, submitLabel = "Save", destructive = false, action }) {
    dialogTitle.textContent = title;
    dialogDescription.textContent = description;
    dialogDescription.hidden = !description;
    nameField.hidden = !nameVisible;
    selectField.hidden = !selectVisible;
    nameInput.value = name;
    submitDialogButton.textContent = submitLabel;
    submitDialogButton.classList.toggle("danger-button", destructive);
    dialogAction = action;
    dialog.showModal();
    if (nameVisible) {
      nameInput.focus();
      nameInput.select();
    } else if (selectVisible) {
      playlistSelect.focus();
    } else {
      submitDialogButton.focus();
    }
  }

  function openCreateDialog(addMediaId = null) {
    showDialog({
      title: "Create playlist",
      nameVisible: true,
      submitLabel: "Create",
      action: async () => {
        await createPlaylist(nameInput.value);
        await loadLibrary();
        const created = playlists.find((playlist) => playlist.name.toLocaleLowerCase() === nameInput.value.trim().replace(/\s+/g, " ").toLocaleLowerCase());
        if (created && addMediaId) {
          await addMediaToPlaylist(created.id, addMediaId);
          activeView = created.id;
        } else if (created) {
          activeView = created.id;
        }
        await render();
        setStatus(addMediaId ? "Playlist created and media added." : "Playlist created.");
      },
    });
  }

  function openAddToPlaylistDialog(record) {
    const availablePlaylists = playlists.filter((playlist) => !playlist.mediaIds.includes(record.id));
    if (playlists.length === 0 || availablePlaylists.length === 0) {
      if (playlists.length > 0) {
        setStatus("This media is already in every playlist.");
        return;
      }
      openCreateDialog(record.id);
      return;
    }

    playlistSelect.replaceChildren();
    availablePlaylists.forEach((playlist) => {
      const option = document.createElement("option");
      option.value = playlist.id;
      option.textContent = playlist.name;
      playlistSelect.append(option);
    });
    showDialog({
      title: "Add to playlist",
      selectVisible: true,
      submitLabel: "Add",
      action: async () => {
        const playlist = playlists.find((item) => item.id === playlistSelect.value);
        if (!playlist) throw new Error("Choose a playlist first.");
        await addMediaToPlaylist(playlist.id, record.id);
        activeView = playlist.id;
        await render();
        setStatus(`Added to ${playlist.name}.`);
      },
    });
  }

  function openRenameDialog(playlist) {
    showDialog({
      title: "Rename playlist",
      name: playlist.name,
      nameVisible: true,
      submitLabel: "Save",
      action: async () => {
        await renamePlaylist(playlist.id, nameInput.value);
        await loadLibrary();
        await render();
        setStatus("Playlist renamed.");
      },
    });
  }

  function openDeletePlaylistDialog(playlist) {
    showDialog({
      title: "Delete playlist?",
      description: `“${playlist.name}” will be deleted. The media files will stay in your library.`,
      submitLabel: "Delete",
      destructive: true,
      action: async () => {
        await deletePlaylist(playlist.id);
        if (activeView === playlist.id) activeView = "all";
        await loadLibrary();
        await render();
        setStatus("Playlist deleted. Your media files are still in the library.");
      },
    });
  }

  function openDeleteMediaDialog(record) {
    showDialog({
      title: "Delete media?",
      description: `“${record.name}” will be deleted from this device and removed from any playlists.`,
      submitLabel: "Delete",
      destructive: true,
      action: async () => {
        await deleteMediaFile(record.id);
        onDeleted?.(record);
        await render();
        setStatus("Media deleted from this device.");
      },
    });
  }

  function renderPlaylistSidebar() {
    playlistList.replaceChildren();
    playlists.forEach((playlist) => {
      const item = document.createElement("li");
      item.className = "playlist-item";
      if (activeView === playlist.id) item.classList.add("is-selected");

      const selectButton = document.createElement("button");
      selectButton.type = "button";
      selectButton.className = "playlist-item-button";
      if (activeView === playlist.id) selectButton.setAttribute("aria-current", "page");
      selectButton.addEventListener("click", () => {
        window.dispatchEvent(new CustomEvent("puffin:library-view", { detail: { view: "playlists", playlistId: playlist.id } }));
      });

      const name = document.createElement("span");
      name.className = "playlist-item-name";
      name.textContent = playlist.name;
      selectButton.append(name);
      if (playlist.pinned) {
        const pinMark = document.createElement("span");
        pinMark.className = "playlist-pin-mark";
        pinMark.setAttribute("aria-label", "Pinned");
        pinMark.textContent = "◆";
        selectButton.append(pinMark);
      }

      const count = document.createElement("span");
      count.className = "playlist-item-count";
      count.textContent = String(playlist.mediaIds.length);
      selectButton.append(count);

      const actions = document.createElement("details");
      actions.className = "playlist-overflow";
      const summary = document.createElement("summary");
      summary.setAttribute("aria-label", `More options for ${playlist.name}`);
      summary.title = `More options for ${playlist.name}`;
      summary.textContent = "•••";
      actions.append(summary);

      const menu = document.createElement("div");
      menu.className = "playlist-action-menu";
      const pinButton = document.createElement("button");
      pinButton.type = "button";
      pinButton.textContent = playlist.pinned ? "Unpin from top" : "Pin to top";
      pinButton.addEventListener("click", async (event) => {
        event.stopPropagation();
        await setPlaylistPinned(playlist.id, !playlist.pinned);
        await loadLibrary();
        await render();
      });

      const renameButton = document.createElement("button");
      renameButton.type = "button";
      renameButton.textContent = "Rename";
      renameButton.addEventListener("click", (event) => {
        event.stopPropagation();
        actions.open = false;
        openRenameDialog(playlist);
      });

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "delete-playlist-action";
      deleteButton.textContent = "Delete";
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        actions.open = false;
        openDeletePlaylistDialog(playlist);
      });
      menu.append(pinButton, renameButton, deleteButton);
      actions.append(menu);
      item.append(selectButton, actions);
      playlistList.append(item);
    });
  }

  function renderMediaRow(record, playlist) {
    const item = document.createElement("li");
    item.className = "media-item";

    const artwork = document.createElement("img");
    artwork.className = "media-row-artwork";
    artwork.src = record.artwork || "/favicon.svg";
    artwork.alt = "";
    artwork.addEventListener("error", () => { if (!artwork.src.endsWith("/favicon.svg")) artwork.src = "/favicon.svg"; }, { once: true });
    const info = document.createElement("div");
    info.className = "media-info";
    const name = document.createElement("span");
    name.className = "media-name";
    name.textContent = record.title || record.name.replace(/\.[^.]+$/, "");
    const details = document.createElement("span");
    details.className = "media-details";
    const typeLabel = record.kind === "video" ? "Video" : "Audio";
    const formatDuration = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
    const updateDetails = (duration = record.duration) => {
      details.textContent = [
        record.artist,
        record.album,
        Number.isFinite(duration) && duration > 0 ? formatDuration(duration) : "",
        typeLabel,
      ].filter(Boolean).join(" · ");
    };
    updateDetails();
    if (!Number.isFinite(record.duration)) {
      getMediaBlob(record.id).then((blob) => {
        if (!blob) return;
        const element = document.createElement(record.kind === "video" ? "video" : "audio");
        const url = URL.createObjectURL(blob);
        element.preload = "metadata";
        element.onloadedmetadata = () => { updateDetails(element.duration); URL.revokeObjectURL(url); };
        element.onerror = () => URL.revokeObjectURL(url);
        element.src = url;
      }).catch(() => {});
    }
    info.append(name, details);

    const actions = document.createElement("div");
    actions.className = "media-actions";
    actions.append(iconButton("Play", ICONS.play, "media-action", () => onPlay(record)));
    const overflow = document.createElement("details");
    overflow.className = "media-overflow";
    const summary = document.createElement("summary");
    summary.setAttribute("aria-label", `More options for ${record.title || record.name}`);
    summary.title = "More options";
    summary.textContent = "•••";
    const menu = document.createElement("div");
    menu.className = "media-overflow-menu";
    const more = document.createElement("button");
    more.type = "button";
    more.textContent = "More";
    more.addEventListener("click", () => {
      const popup = document.querySelector("#media-details-dialog");
      const limit = getMediaStorageLimit();
      const percent = limit > 0 ? (record.size / limit * 100).toFixed(2) : "0.00";
      document.querySelector("#media-details-title").textContent = record.title || record.name;
      document.querySelector("#media-details-content").textContent = `Added ${new Date(record.importedAt).toLocaleDateString()} · ${formatBytes(record.size)} · ${percent}% of storage limit`;
      overflow.open = false;
      popup.showModal();
    });
    menu.append(more);
    if (playlist) {
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Remove from playlist";
      remove.addEventListener("click", async () => {
        await removeMediaFromPlaylist(playlist.id, record.id);
        await render();
        setStatus(`Removed from ${playlist.name}.`);
      }); menu.append(remove);
    } else {
      const add = document.createElement("button"); add.type = "button"; add.textContent = "Add to playlist"; add.addEventListener("click", () => openAddToPlaylistDialog(record)); menu.append(add);
      if (record.kind === "audio") { const queue = document.createElement("button"); queue.type = "button"; queue.textContent = "Add to queue"; queue.addEventListener("click", () => { window.dispatchEvent(new CustomEvent("puffin:add-to-queue", { detail: record })); overflow.open = false; }); menu.append(queue); }
    }
    const removeLibrary = document.createElement("button"); removeLibrary.type = "button"; removeLibrary.className = "danger-menu-action"; removeLibrary.textContent = "Delete from library"; removeLibrary.addEventListener("click", () => openDeleteMediaDialog(record)); menu.append(removeLibrary);
    overflow.append(summary, menu);
    actions.append(overflow);
    item.append(artwork, info, actions);
    return item;
  }

  function renderMediaList() {
    mediaList.replaceChildren();
    let playlist = activeView === "all" ? null : playlists.find((item) => item.id === activeView);
    if (activeView !== "all" && !playlist) {
      activeView = "all";
      playlist = null;
    }
    const viewingPlaylist = Boolean(playlist);
    playlistBrowser.hidden = currentLibraryView !== "playlists";
    libraryLayout.classList.toggle("is-playlist-view", currentLibraryView === "playlists");
    playPanel.setAttribute("aria-label", viewingPlaylist ? "Playlist" : "Library");
    playPanel.removeAttribute("aria-labelledby");
    const selectedRecords = playlist
      ? playlist.mediaIds.map((id) => mediaRecords.find((record) => record.id === id)).filter(Boolean)
      : currentLibraryView === "playlists" ? [] : mediaRecords;
    const visibleRecords = mediaKindFilter
      ? selectedRecords.filter((record) => record.kind === mediaKindFilter)
      : selectedRecords;

    viewEyebrow.textContent = playlist ? "PLAYLISTS" : mediaKindFilter === "audio" ? "YOUR MUSIC" : "LIBRARY";
    viewTitle.textContent = playlist?.name || (currentLibraryView === "playlists" ? "Playlists" : mediaKindFilter === "audio" ? "Listen" : "All media");
    viewCount.textContent = `${visibleRecords.length} ${visibleRecords.length === 1 ? "item" : "items"}`;
    viewActions.replaceChildren();

    if (visibleRecords.length === 0) {
      const empty = document.createElement("li");
      empty.className = "playlist-empty-state";
      if (currentLibraryView === "playlists" && !playlist) {
        return;
      } else if (playlist) {
        const message = document.createElement("p");
        message.textContent = "This playlist is empty.";
        const browse = document.createElement("button");
        browse.type = "button";
        browse.className = "secondary-button";
        browse.textContent = "Browse all media";
        browse.addEventListener("click", () => {
          activeView = "all";
          mediaKindFilter = null;
          render();
        });
        empty.append(message, browse);
      } else {
        const message = document.createElement("p");
        message.textContent = mediaKindFilter === "audio" ? "No music is available in your library yet." : "Your library is empty.";
        empty.append(message);
      }
      mediaList.append(empty);
      return;
    }

    visibleRecords.forEach((record) => mediaList.append(renderMediaRow(record, playlist)));
  }

  async function loadLibrary() {
    [mediaRecords, playlists] = await Promise.all([listMediaFiles(), listPlaylists()]);
  }

  async function render() {
    try {
      await loadLibrary();
      if (activeView !== "all" && !playlists.some((playlist) => playlist.id === activeView)) {
        activeView = "all";
      }
      renderPlaylistSidebar();
      renderPinnedNavigation();
      renderMediaList();
      await updateStorageSummary();
    } catch (error) {
      setStatus(`Could not open your library: ${error.message}`);
      libraryStorage.textContent = "Browser storage information is unavailable.";
    }
  }

  function renderPinnedNavigation() {
    pinnedNav.replaceChildren();
    playlists.filter((playlist) => playlist.pinned).forEach((playlist) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "nav-button pinned-playlist-link";
      button.setAttribute("aria-label", playlist.name);
      button.title = playlist.name;
      const icon = document.createElement("span"); icon.className = "nav-icon"; icon.textContent = "♫";
      const label = document.createElement("span"); label.className = "nav-label"; label.textContent = playlist.name;
      button.append(icon, label);
      button.addEventListener("click", () => {
        document.querySelector('[data-tab="play"][data-library-view="playlists"]').click();
        window.dispatchEvent(new CustomEvent("puffin:library-view", { detail: { view: "playlists", playlistId: playlist.id } }));
      });
      item.append(button); pinnedNav.append(item);
    });
  }
  window.addEventListener("puffin:library-view", async (event) => {
    const view = typeof event.detail === "string" ? event.detail : event.detail?.view;
    if (!["listen", "library", "playlists"].includes(view)) return;
    currentLibraryView = view;
    mediaKindFilter = view === "listen" ? "audio" : null;
    activeView = view === "playlists" ? (typeof event.detail === "object" && event.detail.playlistId ? event.detail.playlistId : "all") : "all";
    playPanel.setAttribute("aria-label", view === "playlists" ? "Playlists" : view === "listen" ? "Listen" : "Library");
    playPanel.removeAttribute("aria-labelledby");
    await render();
    if (view === "playlists") {
      const sidebar = document.querySelector(".playlist-sidebar");
      sidebar?.scrollIntoView({ block: "nearest" });
      sidebar?.focus({ preventScroll: true });
    }
  });
  createPlaylistButton.addEventListener("click", () => openCreateDialog());
  cancelDialogButton.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialogForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!dialogAction) return;
    submitDialogButton.disabled = true;
    try {
      await dialogAction();
      dialog.close();
      dialogAction = null;
    } catch (error) {
      setStatus(error.message || "The playlist action failed.");
    } finally {
      submitDialogButton.disabled = false;
    }
  });

  window.addEventListener("puffin:library-updated", () => render());
  window.addEventListener("puffin:metadata-updated", () => render());
  render().then(() => {
    renderPinnedNavigation();
    if (mediaRecords.length === 0) setStatus("Your library is empty.");
    else setStatus(`${mediaRecords.length} ${mediaRecords.length === 1 ? "file" : "files"} in your library.`);
  });
}
