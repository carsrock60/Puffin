import { listMediaFiles, updateMediaMetadata, getMediaBlob, recordPuffinActivity } from "./library.js";
import { fetchSyncedLyrics } from "./lyrics.js";
import { fingerprintAudioBlob, lookupAcoustID } from "./audio-fingerprint.js";
import { getHomePreferences } from "./home-preferences.js";

const fields = ["title", "artist", "album", "genre", "year", "track"];
const get = (id) => document.querySelector(`#${id}`);

function extension(name) { return name.match(/\.[^.]+$/)?.[0] || ""; }
function titleFromName(name) { const suffix = extension(name); return (suffix ? name.slice(0, -suffix.length) : name).trim(); }
function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
function validDuration(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : NaN;
}
function readDuration(blob) {
  return new Promise((resolve) => {
    const element = document.createElement(blob.type.startsWith("video/") ? "video" : "audio");
    const url = URL.createObjectURL(blob);
    element.preload = "metadata";
    element.onloadedmetadata = () => { const duration = element.duration; URL.revokeObjectURL(url); resolve(duration); };
    element.onerror = () => { URL.revokeObjectURL(url); resolve(NaN); };
    element.src = url;
  });
}
async function imageAsArtwork(file) {
  let source;
  let cleanup = () => {};
  if (globalThis.createImageBitmap) {
    try { source = await createImageBitmap(file); cleanup = () => source.close?.(); } catch { /* Fall back to Image decoding, including for SVG. */ }
  }
  if (!source) {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.src = url;
    try { await image.decode(); source = image; cleanup = () => URL.revokeObjectURL(url); }
    catch { URL.revokeObjectURL(url); throw new Error("Puffin couldn’t open that image file."); }
  }
  const scale = Math.min(1, 700 / Math.max(source.width || source.naturalWidth, source.height || source.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round((source.width || source.naturalWidth) * scale));
  canvas.height = Math.max(1, Math.round((source.height || source.naturalHeight) * scale));
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  cleanup();
  return canvas.toDataURL("image/jpeg", 0.86);
}

export function initializeEdit({ onPreview } = {}) {
  const list = get("edit-media-list");
  const status = get("edit-status");
  const selected = new Set();
  const preview = get("artwork-preview");
  const previewImage = get("artwork-preview-image");
  const smartFillDialog = get("smart-fill-preview");
  const smartFillPreviewList = get("smart-fill-preview-list");
  const smartFillPreviewSummary = get("smart-fill-preview-summary");
  const smartFillCancel = get("smart-fill-cancel");
  const smartFillApply = get("smart-fill-apply");
  const smartFillBack = get("smart-fill-back");
  const smartFillTitle = get("smart-fill-preview-title");
  let records = [];
  let pendingSmartFill = [];
  let smartFillTracks = [];
  let smartFillStage = "candidates";
  let smartFillLoading = false;
  const say = (message) => { status.textContent = message; };
  const getSelected = () => records.filter((record) => selected.has(record.id));

  function updateCount() {
    get("edit-selection-count").textContent = `${selected.size} selected`;
    get("edit-select-all").checked = records.length > 0 && selected.size === records.length;
  }

  function render() {
    list.replaceChildren();
    records.forEach((record) => {
      const row = document.createElement("li"); row.className = "edit-media-row";
      const check = document.createElement("input"); check.type = "checkbox"; check.checked = selected.has(record.id); check.setAttribute("aria-label", `Select ${record.title || titleFromName(record.name)}`);
      check.addEventListener("change", () => { check.checked ? selected.add(record.id) : selected.delete(record.id); updateCount(); });
      const art = document.createElement("img"); art.className = "edit-artwork"; art.src = record.artwork || "/favicon.svg"; art.alt = "";
      art.addEventListener("error", () => { if (!art.src.endsWith("/favicon.svg")) art.src = "/favicon.svg"; }, { once: true });
      const artWrap = document.createElement("div"); artWrap.className = "edit-artwork-wrap";
      const uploadButton = document.createElement("button"); uploadButton.type = "button"; uploadButton.className = "edit-artwork-upload"; uploadButton.textContent = "+"; uploadButton.title = "Change artwork"; uploadButton.setAttribute("aria-label", `Change artwork for ${record.title || titleFromName(record.name)}`);
      const imageInput = document.createElement("input"); imageInput.type = "file"; imageInput.accept = "image/*,.svg,image/svg+xml"; imageInput.hidden = true;
      uploadButton.addEventListener("click", () => imageInput.click());
      imageInput.addEventListener("change", async () => {
        const file = imageInput.files?.[0]; imageInput.value = ""; if (!file) return;
        try { await updateMediaMetadata(record.id, { artwork: await imageAsArtwork(file) }); say("Artwork updated."); }
        catch (error) { say(error.message || "Could not update artwork."); }
      });
      art.title = "Shift-click to view artwork larger";
      art.addEventListener("click", (event) => {
        if (!event.shiftKey) return;
        event.preventDefault();
        previewImage.src = record.artwork || "/favicon.svg";
        preview.showModal();
      });
      artWrap.append(art, uploadButton, imageInput);
      const values = document.createElement("div"); values.className = "edit-track-fields";
      const inputs = {};
      for (const key of ["title", "artist", "album"]) {
        const input = document.createElement("input"); input.type = "text"; input.value = record[key] || (key === "title" ? titleFromName(record.name) : ""); input.placeholder = key[0].toUpperCase() + key.slice(1); input.setAttribute("aria-label", `${key} for ${titleFromName(record.name)}`); inputs[key] = input;
      }
      values.append(inputs.title, inputs.artist, inputs.album);
      const meta = document.createElement("div"); meta.className = "edit-track-meta";
      const detail = document.createElement("span"); detail.textContent = `${record.kind === "video" ? "Video" : "Audio"} · `;
      const duration = document.createElement("span"); duration.textContent = "…";
      let measuredDuration = Number.isFinite(record.duration) ? record.duration : undefined;
      meta.append(detail, duration);
      const save = document.createElement("button"); save.type = "button"; save.className = "icon-button edit-save"; save.textContent = "✓"; save.title = "Save tags"; save.setAttribute("aria-label", `Save tags for ${titleFromName(record.name)}`);
      save.addEventListener("click", async () => {
        save.disabled = true;
        try { await updateMediaMetadata(record.id, Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value.trim()]))); recordPuffinActivity("tagEdits").catch(() => {}); await load(); say("Tags saved."); }
        catch (error) { say(error.message || "Could not save tags."); }
        finally { save.disabled = false; }
      });
      const smart = document.createElement("button"); smart.type = "button"; smart.className = "secondary-button edit-row-smart"; smart.textContent = "Smart Fill";
      smart.addEventListener("click", () => smartFill([record]));
      const rowActions = document.createElement("div"); rowActions.className = "edit-row-actions"; rowActions.append(smart);
      if (record.kind === "audio") {
        const lyrics = document.createElement("button");
        lyrics.type = "button";
        lyrics.className = "icon-button edit-lyrics-download";
        lyrics.textContent = "♫";
        lyrics.title = record.syncedLyrics ? "Refresh synchronized lyrics" : "Download synchronized lyrics";
        lyrics.setAttribute("aria-label", `${lyrics.title} for ${record.title || titleFromName(record.name)}`);

        const syncButton = document.createElement("button");
        syncButton.type = "button";
        syncButton.className = "icon-button edit-lyrics-sync";
        syncButton.textContent = "✎";
        syncButton.title = record.syncedLyrics ? "Adjust lyrics timing" : "Download synchronized lyrics first";
        syncButton.setAttribute("aria-label", `Adjust lyrics timing for ${record.title || titleFromName(record.name)}`);
        syncButton.setAttribute("aria-expanded", "false");
        syncButton.disabled = !record.syncedLyrics;

        const syncPanel = document.createElement("section");
        syncPanel.className = "edit-lyrics-sync-panel";
        syncPanel.setAttribute("aria-label", `Lyrics timing adjustment for ${record.title || titleFromName(record.name)}`);
        syncPanel.hidden = true;
        const syncPanelHeading = document.createElement("div");
        syncPanelHeading.className = "edit-lyrics-sync-heading";
        const syncPanelTitle = document.createElement("strong");
        syncPanelTitle.textContent = "Adjust lyrics timing";
        const syncPanelHint = document.createElement("span");
        syncPanelHint.textContent = "− moves lyrics earlier, + moves them later. Changes save automatically and work offline.";
        syncPanelHeading.append(syncPanelTitle, syncPanelHint);

        const syncPanelActions = document.createElement("div");
        syncPanelActions.className = "edit-lyrics-sync-actions";
        const previewTrack = document.createElement("button");
        previewTrack.type = "button";
        previewTrack.className = "secondary-button edit-lyrics-preview";
        previewTrack.textContent = "▶ Play from start";
        previewTrack.disabled = typeof onPreview !== "function";
        previewTrack.addEventListener("click", async () => {
          previewTrack.disabled = true;
          try {
            const started = await onPreview?.(record);
            say(started
              ? `Playing ${record.title || titleFromName(record.name)}. Adjust the timing while it plays.`
              : "Puffin couldn’t start this track for preview.");
          } catch (error) {
            say(error.message || "Puffin couldn’t start this track for preview.");
          } finally {
            previewTrack.disabled = typeof onPreview !== "function";
          }
        });

        const adjustmentValue = document.createElement("strong");
        adjustmentValue.className = "edit-lyrics-sync-value";
        const adjustmentButtons = [];
        const adjustmentGroup = document.createElement("div");
        adjustmentGroup.className = "edit-lyrics-sync-steps";
        const currentAdjustment = () => {
          const value = Number(record.lyricsTimingAdjustmentMs);
          return Number.isFinite(value) ? value : 0;
        };
        const updateAdjustmentValue = () => {
          const value = currentAdjustment();
          adjustmentValue.textContent = value === 0
            ? "No adjustment"
            : `${(Math.abs(value) / 1000).toFixed(1)} s ${value > 0 ? "later" : "earlier"}`;
        };
        let adjustmentSaving = false;
        const saveAdjustment = async (value) => {
          if (adjustmentSaving) return;
          adjustmentSaving = true;
          [...adjustmentButtons, resetAdjustment].forEach((button) => { button.disabled = true; });
          try {
            const updatedRecord = await updateMediaMetadata(record.id, { lyricsTimingAdjustmentMs: value });
            Object.assign(record, updatedRecord);
            updateAdjustmentValue();
            say(`Lyrics timing saved for ${record.title || titleFromName(record.name)}.`);
          } catch (error) {
            say(error.message || "Could not save the lyrics timing adjustment.");
          } finally {
            adjustmentSaving = false;
            adjustmentButtons.forEach((button) => { button.disabled = false; });
            resetAdjustment.disabled = currentAdjustment() === 0;
          }
        };
        for (const [label, change, direction] of [
          ["−0.5 s", -500, "earlier"],
          ["−0.1 s", -100, "earlier"],
          ["+0.1 s", 100, "later"],
          ["+0.5 s", 500, "later"],
        ]) {
          const step = document.createElement("button");
          step.type = "button";
          step.className = "secondary-button";
          step.textContent = label;
          step.setAttribute("aria-label", `Move lyrics ${direction} by ${Math.abs(change) / 1000} seconds`);
          step.addEventListener("click", () => saveAdjustment(currentAdjustment() + change));
          adjustmentButtons.push(step);
          adjustmentGroup.append(step);
        }
        const resetAdjustment = document.createElement("button");
        resetAdjustment.type = "button";
        resetAdjustment.className = "secondary-button edit-lyrics-sync-reset";
        resetAdjustment.textContent = "Reset";
        resetAdjustment.disabled = currentAdjustment() === 0;
        resetAdjustment.addEventListener("click", () => saveAdjustment(0));
        adjustmentButtons.push(resetAdjustment);
        updateAdjustmentValue();
        syncPanelActions.append(previewTrack, adjustmentValue, adjustmentGroup);
        syncPanel.append(syncPanelHeading, syncPanelActions);

        syncButton.addEventListener("click", () => {
          syncPanel.hidden = !syncPanel.hidden;
          syncButton.setAttribute("aria-expanded", String(!syncPanel.hidden));
          syncButton.textContent = syncPanel.hidden ? "✎" : "×";
          syncButton.title = syncPanel.hidden ? "Adjust lyrics timing" : "Close lyrics timing adjustment";
        });

        lyrics.addEventListener("click", async () => {
          const trackName = inputs.title.value.trim() || titleFromName(record.name);
          const artistName = inputs.artist.value.trim();
          if (!artistName) { say(`Add an artist for ${trackName} before looking up lyrics.`); return; }
          lyrics.disabled = true;
          say(`Looking up synchronized lyrics for ${trackName}…`);
          try {
            if (!Number.isFinite(measuredDuration) || measuredDuration <= 0) {
              const blob = await getMediaBlob(record.id);
              if (blob) measuredDuration = await readDuration(blob);
            }
            const result = await fetchSyncedLyrics({
              trackName,
              artistName,
              albumName: inputs.album.value.trim(),
              duration: measuredDuration,
            });
            const updatedRecord = await updateMediaMetadata(record.id, {
              syncedLyrics: result.syncedLyrics,
              lyricsProvider: "LRCLIB",
              lyricsRecordId: result.id,
              lyricsFetchedAt: Date.now(),
            });
            Object.assign(record, updatedRecord);
            syncButton.disabled = false;
            syncButton.title = "Adjust lyrics timing";
            say(`Synchronized lyrics saved for ${trackName}. They’re available offline.`);
          } catch (error) {
            say(error.message || `Could not download lyrics for ${trackName}.`);
          } finally {
            lyrics.disabled = false;
          }
        });
        rowActions.append(lyrics, syncButton);
        row.append(syncPanel);
      }
      row.prepend(check, artWrap, values, meta, rowActions, save);
      list.append(row);
      getMediaBlob(record.id).then((blob) => blob && readDuration(blob)).then((seconds) => {
        duration.textContent = formatDuration(seconds);
        if (Number.isFinite(seconds) && seconds > 0) measuredDuration = seconds;
      }).catch(() => { duration.textContent = "—"; });
    });
    if (!records.length) { const empty = document.createElement("li"); empty.className = "playlist-empty-state"; empty.textContent = "Add media to your library to edit its metadata."; list.append(empty); }
    updateCount();
  }

  async function load() {
    records = await listMediaFiles();
    selected.forEach((id) => { if (!records.some((item) => item.id === id)) selected.delete(id); });
    render();
  }

  function displayMetadataValue(key, value) {
    if (key === "duration") return Number.isFinite(Number(value)) ? formatDuration(Number(value)) : "Not set";
    return String(value ?? "").trim() || "Not set";
  }

  function makeArtworkPreview(label, source) {
    const figure = document.createElement("figure");
    figure.className = "smart-fill-preview-artwork-item";
    const caption = document.createElement("figcaption");
    caption.textContent = label;
    figure.append(caption);
    if (source) {
      const image = document.createElement("img");
      image.src = source;
      image.alt = `${label} artwork`;
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => {
        const unavailable = document.createElement("span");
        unavailable.textContent = "Preview unavailable";
        image.replaceWith(unavailable);
      }, { once: true });
      figure.append(image);
    } else {
      const empty = document.createElement("span");
      empty.textContent = "No artwork";
      figure.append(empty);
    }
    return figure;
  }

  function makeSmartFillPreviewCard({ record, updates, candidate }) {
    const card = document.createElement("article");
    card.className = "smart-fill-preview-card";
    const heading = document.createElement("h3");
    heading.textContent = record.title || titleFromName(record.name);
    const match = document.createElement("p");
    match.className = "muted smart-fill-match-summary";
    match.textContent = `${candidate.title}${candidate.artist ? ` · ${candidate.artist}` : ""} · ${candidate.source === "Fingerprint" ? `AcoustID match ${(candidate.score * 100).toFixed(1)}%` : "Title search match"}`;
    card.append(heading, match);

    const fieldsToPreview = [
      ["title", "Title", record.title || titleFromName(record.name)],
      ["artist", "Artist", record.artist],
      ["album", "Album", record.album],
      ["year", "Year", record.year],
      ["duration", "Duration", record.duration],
    ];
    const changes = document.createElement("dl");
    changes.className = "smart-fill-preview-changes";
    for (const [key, label, currentValue] of fieldsToPreview) {
      if (!(key in updates)) continue;
      const row = document.createElement("div");
      row.className = "smart-fill-preview-change";
      const name = document.createElement("dt");
      name.textContent = label;
      const current = document.createElement("dd");
      current.textContent = displayMetadataValue(key, currentValue);
      const arrow = document.createElement("span");
      arrow.className = "smart-fill-preview-arrow";
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = "→";
      const proposed = document.createElement("dd");
      proposed.className = "smart-fill-preview-proposed";
      proposed.textContent = displayMetadataValue(key, updates[key]);
      row.append(name, current, arrow, proposed);
      changes.append(row);
    }
    card.append(changes);

    if ("artwork" in updates) {
      const artwork = document.createElement("div");
      artwork.className = "smart-fill-preview-artwork";
      artwork.append(
        makeArtworkPreview("Current artwork", record.artwork),
        makeArtworkPreview("Suggested artwork", updates.artwork),
      );
      card.append(artwork);
    }
    return card;
  }

  function artistCredit(credits = []) {
    return credits.map((credit) => `${credit.name || credit.artist?.name || ""}${credit.joinphrase || ""}`).join("").trim();
  }

  function rankCandidates(candidates, duration) {
    return candidates.sort((a, b) => {
      const scoreDifference = (b.score || 0) - (a.score || 0);
      if (Math.abs(scoreDifference) > 0.0001) return scoreDifference;
      const aDelta = Number.isFinite(a.duration) ? Math.abs(a.duration - duration) : Infinity;
      const bDelta = Number.isFinite(b.duration) ? Math.abs(b.duration - duration) : Infinity;
      return aDelta - bDelta;
    }).slice(0, 6);
  }

  function acoustidCandidates(results, duration) {
    const candidatesById = new Map();
    for (const result of results) {
      const score = Number(result.score) || 0;
      for (const recording of result.recordings || []) {
        if (!recording.id) continue;
        const current = candidatesById.get(recording.id);
        if (current && current.score >= score) continue;
        const artist = (recording.artists || []).map((item) => item.name).filter(Boolean).join(", ");
        const releaseGroup = recording.releasegroups?.[0];
        candidatesById.set(recording.id, {
          id: recording.id,
          title: recording.title || "Untitled recording",
          artist,
          album: releaseGroup?.title || "",
          duration: validDuration(recording.duration),
          score,
          source: "Fingerprint",
        });
      }
    }
    return rankCandidates([...candidatesById.values()], duration);
  }

  async function searchByTitle(record, duration) {
    const title = record.title || titleFromName(record.name);
    const phrase = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
    const primaryArtist = record.artist?.split(/[,;&/]|\b(?:feat\.?|ft\.?)\b/i)[0].trim();
    const query = `recording:${phrase(title)}${primaryArtist ? ` AND artist:${phrase(primaryArtist)}` : ""}`;
    const response = await fetch(`https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}&fmt=json&limit=8`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`MusicBrainz returned ${response.status}.`);
    const data = await response.json();
    const candidates = (data.recordings || []).map((match) => ({
      id: match.id,
      title: match.title || title,
      artist: artistCredit(match["artist-credit"]),
      duration: validDuration(match.length) / 1000,
      score: (Number(match.score) || 0) / 100,
      source: "Title search",
    })).filter((candidate) => candidate.id);
    const lexicalCandidates = rankCandidates(candidates, duration);
    try {
      const rankingResponse = await fetch("/api/smart-fill/rank", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          title: title.slice(0, 240),
          artist: String(record.artist || "").slice(0, 240),
          duration: Number.isFinite(duration) && duration > 0 ? duration : null,
          candidates: lexicalCandidates.map((candidate) => ({
            id: candidate.id,
            title: candidate.title.slice(0, 240),
            artist: candidate.artist.slice(0, 240),
            duration: Number.isFinite(candidate.duration) && candidate.duration > 0 ? candidate.duration : null,
            search_score: candidate.score,
          })),
        }),
      });
      if (!rankingResponse.ok) throw new Error(`Groq ranking returned ${rankingResponse.status}.`);
      const ranking = await rankingResponse.json();
      const byId = new Map(lexicalCandidates.map((candidate) => [candidate.id, candidate]));
      const ordered = [];
      for (const ranked of ranking.ranked_candidates || []) {
        const candidate = byId.get(ranked.id);
        if (!candidate) continue;
        ordered.push({ ...candidate, aiScore: ranked.score, aiReason: ranked.reason });
        byId.delete(ranked.id);
      }
      ordered.push(...byId.values());
      const bestMatchId = ordered.some((candidate) => candidate.id === ranking.best_match_id)
        ? ranking.best_match_id
        : "";
      return { candidates: ordered, bestMatchId, rankingAvailable: true };
    } catch {
      return { candidates: lexicalCandidates, bestMatchId: "", rankingAvailable: false };
    }
  }

  function renderCandidateChoices() {
    smartFillStage = "candidates";
    pendingSmartFill = [];
    smartFillTitle.textContent = "Choose the right recordings";
    smartFillBack.hidden = true;
    smartFillApply.disabled = false;
    smartFillApply.textContent = "Review selected recordings";
    const cards = smartFillTracks.map((track, index) => {
      const card = document.createElement("section");
      card.className = "smart-fill-candidate-track";
      const heading = document.createElement("h3");
      heading.textContent = track.record.title || titleFromName(track.record.name);
      card.append(heading);
      if (!track.candidates.length) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = "No recording candidates found.";
        card.append(empty);
        return card;
      }
      const options = document.createElement("div");
      options.className = "smart-fill-candidate-options";
      track.candidates.forEach((candidate, candidateIndex) => {
        const label = document.createElement("label");
        label.className = "smart-fill-candidate-option";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = `smart-fill-track-${index}`;
        radio.value = candidate.id;
        radio.checked = candidate.id === track.selectedId;
        if (radio.checked) track.selectedId = candidate.id;
        radio.addEventListener("change", () => { track.selectedId = candidate.id; });
        const info = document.createElement("span");
        info.className = "smart-fill-candidate-info";
        const title = document.createElement("strong");
        title.textContent = candidate.title;
        const details = document.createElement("small");
        const scoreText = candidate.source === "Fingerprint"
          ? `AcoustID match ${(candidate.score * 100).toFixed(1)}%`
          : Number.isFinite(candidate.aiScore) ? `Groq match ${(candidate.aiScore * 100).toFixed(0)}%` : "AI ranking unavailable";
        const candidateDuration = Number.isFinite(candidate.duration) ? formatDuration(candidate.duration) : "Duration unknown";
        const delta = Number.isFinite(candidate.duration) && Number.isFinite(track.duration) ? ` · ${Math.round(Math.abs(candidate.duration - track.duration))} sec difference` : "";
        const reason = candidate.aiReason ? ` · ${candidate.aiReason}` : "";
        details.textContent = `${candidate.artist || "Artist unknown"} · ${candidateDuration}${delta} · ${scoreText}${reason}`;
        info.append(title, details);
        label.append(radio, info);
        options.append(label);
      });
      card.append(options);
      return card;
    });
    smartFillPreviewList.replaceChildren(...cards);
    const found = smartFillTracks.filter((track) => track.candidates.length).length;
    const usedFingerprint = smartFillTracks.some((track) => track.candidates[0]?.source === "Fingerprint");
    const keyMissing = !getHomePreferences().acoustidClientKey;
    const unrankedFallback = smartFillTracks.some((track) => track.candidates[0]?.source === "Title search" && !track.rankingAvailable);
    const noConfidentFallback = smartFillTracks.some((track) => track.candidates[0]?.source === "Title search" && track.rankingAvailable && !track.selectedId);
    smartFillPreviewSummary.textContent = `${found} of ${smartFillTracks.length} tracks have candidates. Choose one for each track you want to update before reviewing its metadata.${keyMissing ? " No AcoustID key is set, so Puffin used title search; Groq still ranks those candidates." : usedFingerprint ? " Audio was fingerprinted locally; only the fingerprint and duration were sent." : " No fingerprint matches were found, so these are title search results."}${unrankedFallback ? " Groq ranking is unavailable; no search result was preselected." : noConfidentFallback ? " Groq could not confirm a strong match; no search result was preselected." : ""}`;
  }

  async function smartFill(targets) {
    if (!targets.length) { say("Select one or more songs first."); return; }
    if (smartFillLoading || smartFillDialog.open) { say("Finish reviewing the current Smart Fill suggestions first."); return; }
    smartFillLoading = true;
    smartFillTracks = [];
    const acoustidKey = getHomePreferences().acoustidClientKey;
    let failures = 0;
    try {
      for (let i = 0; i < targets.length; i += 1) {
        const record = targets[i];
        const title = record.title || titleFromName(record.name);
        say(`Identifying ${title}… (${i + 1}/${targets.length})`);
        let duration = validDuration(record.duration);
        let candidates = [];
        let selectedId = "";
        let rankingAvailable = false;
        if (acoustidKey && record.kind !== "video") {
          try {
            const blob = await getMediaBlob(record.id);
            if (!blob) throw new Error("The local media file is unavailable.");
            const fingerprinted = await fingerprintAudioBlob(blob);
            duration = fingerprinted.duration;
            const results = await lookupAcoustID({ client: acoustidKey, ...fingerprinted });
            candidates = acoustidCandidates(results, duration);
            selectedId = candidates[0]?.id || "";
            if (i < targets.length - 1) await new Promise((resolve) => setTimeout(resolve, 400));
          } catch (error) {
            recordPuffinActivity("failedJobs", 1, error.message || "Audio fingerprint lookup failed.").catch(() => {});
          }
        }
        if (!candidates.length) {
          say(`Searching by title for ${title}… (${i + 1}/${targets.length})`);
          try {
            const titleSearch = await searchByTitle(record, duration);
            candidates = titleSearch.candidates;
            selectedId = titleSearch.bestMatchId;
            rankingAvailable = titleSearch.rankingAvailable;
          } catch (error) {
            failures += 1;
            recordPuffinActivity("failedJobs", 1, error.message || "Metadata lookup failed.").catch(() => {});
          }
          if (i < targets.length - 1) await new Promise((resolve) => setTimeout(resolve, 1100));
        }
        smartFillTracks.push({ record, duration, candidates, selectedId, rankingAvailable });
      }

      const found = smartFillTracks.filter((track) => track.candidates.length).length;
      if (!found) {
        say(failures ? "Smart Fill couldn’t reach MusicBrainz. Try again later." : "Couldn’t find metadata for the selected songs.");
        return;
      }
      renderCandidateChoices();
      smartFillDialog.showModal();
      say("Choose the matching recording for each track.");
    } finally {
      smartFillLoading = false;
    }
  }

  function metadataUpdates(recording, candidate) {
    const release = recording.releases?.[0];
    const artist = artistCredit(recording["artist-credit"]) || candidate.artist;
    const updates = { title: recording.title || candidate.title };
    if (artist) updates.artist = artist;
    if (release?.title || candidate.album) updates.album = release?.title || candidate.album;
    const date = release?.date || recording["first-release-date"];
    if (date) updates.year = date.slice(0, 4);
    const duration = Number(recording.length) / 1000;
    if (Number.isFinite(duration) && duration > 0) updates.duration = Math.round(duration);
    else if (Number.isFinite(candidate.duration)) updates.duration = Math.round(candidate.duration);
    if (release?.id) updates.artwork = `https://coverartarchive.org/release/${release.id}/front-250`;
    return updates;
  }

  async function loadMetadataPreviews() {
    const selectedMatches = smartFillTracks.flatMap((track) => {
      const candidate = track.candidates.find((item) => item.id === track.selectedId);
      return candidate ? [{ record: track.record, candidate }] : [];
    });
    if (!selectedMatches.length) {
      say("Choose at least one recording to review.");
      return;
    }
    smartFillLoading = true;
    smartFillApply.disabled = true;
    smartFillCancel.disabled = true;
    const suggestions = [];
    let failures = 0;
    try {
      for (let i = 0; i < selectedMatches.length; i += 1) {
        const { record, candidate } = selectedMatches[i];
        say(`Loading metadata for ${candidate.title}… (${i + 1}/${selectedMatches.length})`);
        try {
          const response = await fetch(`https://musicbrainz.org/ws/2/recording/${encodeURIComponent(candidate.id)}?fmt=json&inc=releases`, { headers: { Accept: "application/json" } });
          if (!response.ok) throw new Error(`MusicBrainz returned ${response.status}.`);
          suggestions.push({ record, candidate, updates: metadataUpdates(await response.json(), candidate) });
        } catch (error) {
          failures += 1;
          recordPuffinActivity("failedJobs", 1, error.message || "Could not load recording details.").catch(() => {});
          if (candidate.title) suggestions.push({ record, candidate, updates: metadataUpdates({}, candidate) });
        }
        if (i < selectedMatches.length - 1) await new Promise((resolve) => setTimeout(resolve, 1100));
      }
      if (!suggestions.length) {
        say("Could not load any selected recording metadata. Try again later.");
        return;
      }
      pendingSmartFill = suggestions;
      smartFillStage = "preview";
      smartFillTitle.textContent = "Review metadata changes";
      smartFillBack.hidden = false;
      smartFillPreviewList.replaceChildren(...suggestions.map(makeSmartFillPreviewCard));
      smartFillPreviewSummary.textContent = `${suggestions.length} selected ${suggestions.length === 1 ? "recording is" : "recordings are"} ready to preview${failures ? `; ${failures} used the matched candidate details because MusicBrainz could not be reached` : ""}. Nothing changes until you apply.`;
      smartFillApply.disabled = false;
      smartFillApply.textContent = `Yes, apply to ${suggestions.length} ${suggestions.length === 1 ? "track" : "tracks"}`;
      say("Review the MusicBrainz metadata before applying it.");
    } finally {
      smartFillLoading = false;
      smartFillApply.disabled = false;
      smartFillCancel.disabled = false;
    }
  }

  smartFillCancel.addEventListener("click", () => {
    pendingSmartFill = [];
    smartFillTracks = [];
    smartFillDialog.close("cancel");
    say("Smart Fill suggestions discarded.");
  });
  smartFillBack.addEventListener("click", renderCandidateChoices);
  smartFillDialog.addEventListener("cancel", (event) => {
    if (smartFillLoading) {
      event.preventDefault();
      return;
    }
    pendingSmartFill = [];
    smartFillTracks = [];
  });
  smartFillDialog.addEventListener("close", () => {
    smartFillPreviewList.replaceChildren();
    smartFillApply.disabled = false;
    smartFillCancel.disabled = false;
    smartFillBack.hidden = true;
    pendingSmartFill = [];
    smartFillTracks = [];
  });
  smartFillApply.addEventListener("click", async () => {
    if (smartFillStage === "candidates") {
      await loadMetadataPreviews();
      return;
    }
    if (!pendingSmartFill.length) return;
    const suggestions = pendingSmartFill;
    smartFillApply.disabled = true;
    smartFillCancel.disabled = true;
    let applied = 0;
    let failures = 0;
    for (const { record, updates } of suggestions) {
      try {
        await updateMediaMetadata(record.id, updates);
        applied += 1;
      } catch (error) {
        failures += 1;
        recordPuffinActivity("failedJobs", 1, error.message || "Metadata update failed.").catch(() => {});
      }
    }
    pendingSmartFill = [];
    smartFillDialog.close("apply");
    smartFillCancel.disabled = false;
    if (applied) recordPuffinActivity("tagEdits", applied).catch(() => {});
    if (applied > 1) recordPuffinActivity("batchJobs").catch(() => {});
    await load();
    say(failures
      ? `Applied ${applied} ${applied === 1 ? "suggestion" : "suggestions"}; ${failures} could not be saved.`
      : `Applied Smart Fill to ${applied} ${applied === 1 ? "song" : "songs"}.`);
  });

  get("edit-select-all").addEventListener("change", (event) => { selected.clear(); if (event.target.checked) records.forEach((record) => selected.add(record.id)); render(); });
  get("edit-smart-fill").addEventListener("click", () => smartFill(getSelected()));
  get("apply-batch-tags").addEventListener("click", async () => {
    const targets = getSelected(); if (!targets.length) return say("Select one or more songs first.");
    const updates = Object.fromEntries(["artist", "album", "genre", "year"].map((key) => [key, get(`batch-${key}`).value.trim()]).filter(([, value]) => value));
    if (!Object.keys(updates).length) return say("Enter at least one tag to apply.");
    try { for (const record of targets) await updateMediaMetadata(record.id, updates); recordPuffinActivity("tagEdits", targets.length).catch(() => {}); if (targets.length > 1) recordPuffinActivity("batchJobs").catch(() => {}); await load(); say(`Updated tags on ${targets.length} ${targets.length === 1 ? "song" : "songs"}.`); }
    catch (error) { recordPuffinActivity("failedJobs", 1, error.message || "Could not update selected songs.").catch(() => {}); say(error.message || "Could not update selected songs."); }
  });

  get("batch-artwork-button").addEventListener("click", () => {
    if (!getSelected().length) return say("Select one or more songs first.");
    get("batch-artwork-file").click();
  });
  get("batch-artwork-file").accept = "image/*,.svg,image/svg+xml";
  get("batch-artwork-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    const targets = getSelected();
    try {
      const artwork = await imageAsArtwork(file);
      for (const record of targets) await updateMediaMetadata(record.id, { artwork });
      if (targets.length > 1) recordPuffinActivity("batchJobs").catch(() => {});
      say(`Artwork updated for ${targets.length} ${targets.length === 1 ? "song" : "songs"}.`);
    } catch (error) { recordPuffinActivity("failedJobs", 1, error.message || "Could not update artwork.").catch(() => {}); say(error.message || "Could not update artwork."); }
  });

  get("artwork-preview-close").addEventListener("click", () => preview.close());
  preview.addEventListener("click", (event) => { if (event.target === preview) preview.close(); });

  get("filename-to-tags").addEventListener("click", async () => {
    const targets = getSelected(); if (!targets.length) return say("Select one or more songs first.");
    const mask = get("edit-mask").value;
    const tokens = [...mask.matchAll(/\{(artist|title|album|track|year)\}/gi)];
    if (!tokens.length) return say("Add a field such as {artist} or {title} to the naming mask.");
    const escaped = mask.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{(artist|title|album|track|year)\\\}/gi, "(.+?)");
    const matcher = new RegExp(`^${escaped}(?:\\.[^.]+)?$`, "i"); let count = 0;
    for (const record of targets) {
      const match = titleFromName(record.name).match(matcher); if (!match) continue;
      const updates = {}; tokens.forEach((token, index) => { updates[token[1].toLowerCase()] = match[index + 1].trim(); });
      await updateMediaMetadata(record.id, updates); count += 1;
    }
    if (count) recordPuffinActivity("tagEdits", count).catch(() => {});
    if (count && targets.length > 1) recordPuffinActivity("batchJobs").catch(() => {});
    await load(); say(count ? `Read tags from ${count} filename(s).` : "No selected filenames matched this mask.");
  });

  get("tags-to-filename").addEventListener("click", async () => {
    const targets = getSelected(); if (!targets.length) return say("Select one or more songs first.");
    const mask = get("edit-mask").value;
    let renamed = 0; let missing = 0;
    for (const record of targets) {
      const next = mask.replace(/\{(artist|title|album|track|year)\}/gi, (_, key) => record[key.toLowerCase()] || "").replace(/[<>:"/\\|?*]/g, "-").trim();
      if (!next || /\{[^}]+\}/.test(next)) { missing += 1; continue; }
      await updateMediaMetadata(record.id, { name: `${next}${extension(record.name)}` }); renamed += 1;
    }
    if (renamed && targets.length > 1) recordPuffinActivity("batchJobs").catch(() => {});
    await load(); say(`Renamed ${renamed} file(s)${missing ? `; ${missing} skipped because tags were missing` : ""}.`);
  });

  window.addEventListener("puffin:library-updated", load);
  window.addEventListener("puffin:metadata-updated", load);
  window.addEventListener("puffin:tab-changed", (event) => { if (event.detail === "edit") load(); });
  load().catch((error) => say(error.message || "Could not load your library."));
}
