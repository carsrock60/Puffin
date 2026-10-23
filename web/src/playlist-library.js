import {
  addMediaToPlaylist,
  createPlaylist,
  deleteMediaFile,
  deletePlaylist,
  getMediaKind,
  listMediaFiles,
  listPlaylists,
  removeMediaFromPlaylist,
  renamePlaylist,
  saveMediaFile,
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
  const importButton = document.querySelector("#import-media");
  const filePicker = document.querySelector("#media-files");
  const libraryStatus = document.querySelector("#library-status");
  const libraryStorage = document.querySelector("#library-storage");
  const mediaList = document.querySelector("#media-list");
  const playlistList = document.querySelector("#playlist-list");
  const allMediaButton = document.querySelector("#all-media-view");
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
    allMediaButton.classList.toggle("is-selected", activeView === "all");
    if (activeView === "all") allMediaButton.setAttribute("aria-current", "page");
    else allMediaButton.removeAttribute("aria-current");

    playlists.forEach((playlist) => {
      const item = document.createElement("li");
      item.className = "playlist-item";
      if (activeView === playlist.id) item.classList.add("is-selected");

      const selectButton = document.createElement("button");
      selectButton.type = "button";
      selectButton.className = "playlist-item-button";
      if (activeView === playlist.id) selectButton.setAttribute("aria-current", "page");
      selectButton.addEventListener("click", () => {
        activeView = playlist.id;
        render();
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

    const info = document.createElement("div");
    info.className = "media-info";
    const name = document.createElement("span");
    name.className = "media-name";
    name.textContent = record.name;
    const details = document.createElement("span");
    details.className = "media-details";
    details.textContent = `${record.kind === "video" ? "Video" : "Audio"} · ${formatBytes(record.size)} · Added ${new Date(record.importedAt).toLocaleDateString()}`;
    info.append(name, details);

    const actions = document.createElement("div");
    actions.className = "media-actions";
    actions.append(iconButton("Play", ICONS.play, "media-action", () => onPlay(record)));
    if (playlist) {
      actions.append(iconButton("Remove from playlist", ICONS.remove, "media-action secondary", async () => {
        await removeMediaFromPlaylist(playlist.id, record.id);
        await render();
        setStatus(`Removed from ${playlist.name}.`);
      }));
    } else {
      actions.append(iconButton("Add to playlist", ICONS.add, "media-action secondary", () => openAddToPlaylistDialog(record)));
    }
    actions.append(iconButton("Delete media from this device", ICONS.delete, "media-action danger", () => openDeleteMediaDialog(record)));
    item.append(info, actions);
    return item;
  }

  function renderMediaList() {
    mediaList.replaceChildren();
    const playlist = activeView === "all" ? null : playlists.find((item) => item.id === activeView);
    if (activeView !== "all" && !playlist) activeView = "all";
    const visibleRecords = playlist
      ? playlist.mediaIds.map((id) => mediaRecords.find((record) => record.id === id)).filter(Boolean)
      : mediaRecords;

    viewEyebrow.textContent = playlist ? "PLAYLIST" : "LIBRARY";
    viewTitle.textContent = playlist?.name || "All media";
    viewCount.textContent = `${visibleRecords.length} ${visibleRecords.length === 1 ? "item" : "items"}`;
    viewActions.replaceChildren();

    if (visibleRecords.length === 0) {
      const empty = document.createElement("li");
      empty.className = "playlist-empty-state";
      if (playlist) {
        const message = document.createElement("p");
        message.textContent = "This playlist is empty.";
        const browse = document.createElement("button");
        browse.type = "button";
        browse.className = "secondary-button";
        browse.textContent = "Browse all media";
        browse.addEventListener("click", () => {
          activeView = "all";
          render();
        });
        empty.append(message, browse);
      } else {
        const message = document.createElement("p");
        message.textContent = "Your library is empty. Import media to get started.";
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
      renderMediaList();
      await updateStorageSummary();
    } catch (error) {
      setStatus(`Could not open your library: ${error.message}`);
      libraryStorage.textContent = "Browser storage information is unavailable.";
    }
  }

  allMediaButton.addEventListener("click", () => {
    activeView = "all";
    render();
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

  importButton.addEventListener("click", () => filePicker.click());
  filePicker.addEventListener("change", async () => {
    const files = Array.from(filePicker.files || []);
    filePicker.value = "";
    if (files.length === 0) return;

    importButton.disabled = true;
    let imported = 0;
    let skipped = 0;
    let failure;
    try {
      try {
        if (navigator.storage?.persist) await navigator.storage.persist();
      } catch {
        // Importing can proceed if persistent storage is unavailable.
      }
      for (const file of files) {
        if (!getMediaKind(file.name, file.type)) {
          skipped += 1;
          continue;
        }
        setStatus(`Importing ${file.name}…`);
        try {
          await saveMediaFile(file);
          imported += 1;
        } catch (error) {
          failure = error;
          break;
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      importButton.disabled = false;
    }

    await render();
    if (failure) {
      const reason = failure.name === "QuotaExceededError"
        ? "There is not enough browser storage. Delete some files and try again."
        : failure.message;
      setStatus(`Import stopped after ${imported} file(s): ${reason}`);
    } else if (imported || skipped) {
      const skippedMessage = skipped ? ` ${skipped} unsupported file(s) skipped.` : "";
      setStatus(`Imported ${imported} file(s).${skippedMessage}`);
    } else {
      setStatus(`${mediaRecords.length} ${mediaRecords.length === 1 ? "file" : "files"} in your library.`);
    }
  });

  window.addEventListener("puffin:library-updated", () => render());
  render().then(() => {
    if (mediaRecords.length === 0) setStatus("Your library is empty. Import media to get started.");
    else setStatus(`${mediaRecords.length} ${mediaRecords.length === 1 ? "file" : "files"} in your library.`);
  });
}
