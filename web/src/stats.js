import { getMediaStorageCapacity, getPuffinStats, listMediaFiles } from "./library.js";

const $ = (selector) => document.querySelector(selector);
const number = new Intl.NumberFormat();
let range = "all";
let refreshQueued = false;

function localKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
function formatDuration(milliseconds) {
  const minutes = Math.floor(milliseconds / 60000);
  if (milliseconds > 0 && minutes === 0) return "<1 min";
  if (minutes < 60) return `${number.format(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${number.format(hours)} hr ${remainder} min` : `${number.format(hours)} hr`;
}
function rangeStart() {
  if (range === "all") return null;
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - (Number(range) - 1));
  return localKey(date);
}
function matchingDays(stats, start = rangeStart()) {
  return Object.entries(stats.days || {}).filter(([key]) => !start || key >= start).sort(([a], [b]) => a.localeCompare(b));
}
function sum(days, field) { return days.reduce((total, [, day]) => total + (day[field] || 0), 0); }
function countByMedia(days) {
  const counts = new Map();
  days.forEach(([, day]) => Object.entries(day.trackPlays || {}).forEach(([id, count]) => counts.set(id, (counts.get(id) || 0) + count)));
  return counts;
}
function renderList(selector, items, emptyMessage) {
  const list = $(selector);
  const card = list.closest(".stats-list-card");
  const empty = card.querySelector(".stats-list-empty");
  list.replaceChildren();
  items.forEach(({ primary, secondary }) => {
    const item = document.createElement("li");
    const text = document.createElement("span"); text.className = "stats-item-primary"; text.textContent = primary;
    item.append(text);
    if (secondary) { const detail = document.createElement("span"); detail.className = "stats-item-secondary"; detail.textContent = secondary; item.append(detail); }
    list.append(item);
  });
  empty.textContent = emptyMessage;
  empty.hidden = items.length > 0;
  list.hidden = items.length === 0;
}
function filtered(days) { return days.filter(([key]) => !rangeStart() || key >= rangeStart()); }
function renderChart(days) {
  const buckets = new Map();
  const now = new Date();
  if (range === "all") {
    for (let offset = 11; offset >= 0; offset -= 1) {
      const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      buckets.set(key, { label: date.toLocaleDateString(undefined, { month: "short" }), value: 0 });
    }
    days.forEach(([key, day]) => { const month = key.slice(0, 7); if (buckets.has(month)) buckets.get(month).value += day.listeningMs || 0; });
  } else {
    const count = Number(range);
    for (let offset = count - 1; offset >= 0; offset -= 1) {
      const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - offset);
      buckets.set(localKey(date), { label: count === 7 ? date.toLocaleDateString(undefined, { weekday: "short" }) : String(date.getDate()), value: 0 });
    }
    days.forEach(([key, day]) => { if (buckets.has(key)) buckets.get(key).value = day.listeningMs || 0; });
  }
  const values = [...buckets.values()];
  const maximum = Math.max(...values.map((item) => item.value), 1);
  const chart = $("#stats-chart"); const labels = $("#stats-chart-labels");
  chart.replaceChildren(); labels.replaceChildren();
  values.forEach((item) => {
    const column = document.createElement("div"); column.className = "stats-chart-column";
    const bar = document.createElement("span"); bar.className = "stats-chart-bar";
    bar.style.height = `${item.value ? Math.max(4, item.value / maximum * 100) : 0}%`;
    bar.title = `${item.label}: ${formatDuration(item.value)}`;
    bar.setAttribute("aria-label", bar.title);
    column.append(bar); chart.append(column);
    const label = document.createElement("span"); label.textContent = item.label; labels.append(label);
  });
  const total = values.reduce((n, item) => n + item.value, 0);
  chart.style.gridTemplateColumns = `repeat(${values.length}, minmax(0, 1fr))`;
  labels.style.gridTemplateColumns = `repeat(${values.length}, minmax(0, 1fr))`;
  chart.setAttribute("aria-label", `${range === "all" ? "Monthly" : "Daily"} listening time. ${formatDuration(total)} in this range.`);
}
function listeningStreak(days) {
  const active = new Set(days.filter(([, day]) => (day.listeningMs || 0) > 0).map(([key]) => key));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (!active.has(localKey(today))) today.setDate(today.getDate() - 1);
  let streak = 0;
  while (active.has(localKey(today))) { streak += 1; today.setDate(today.getDate() - 1); }
  return `${number.format(streak)} ${streak === 1 ? "day" : "days"}`;
}
function renderErrors(stats, days) {
  const start = rangeStart();
  const errors = (stats.recentErrors || []).filter((error) => !start || localKey(new Date(error.at)) >= start).slice(0, 5);
  const list = $("#stats-errors"); list.replaceChildren();
  errors.forEach((error) => {
    const item = document.createElement("li");
    const message = document.createElement("span"); message.textContent = error.message;
    const date = document.createElement("time"); date.dateTime = new Date(error.at).toISOString(); date.textContent = new Date(error.at).toLocaleString();
    item.append(message, date); list.append(item);
  });
  $("#stats-errors-wrap").hidden = errors.length === 0;
}

async function renderStats() {
  const [records, stats, capacity] = await Promise.all([listMediaFiles(), getPuffinStats(), getMediaStorageCapacity()]);
  const audio = records.filter((record) => record.kind === "audio");
  const videos = records.filter((record) => record.kind === "video");
  const allDays = matchingDays(stats, null);
  const selectedDays = filtered(allDays);
  const selectedListening = sum(selectedDays, "listeningMs");
  $("#stats-track-count").textContent = number.format(audio.length);
  $("#stats-video-count").textContent = number.format(videos.length);
  $("#stats-listening-total").textContent = formatDuration(selectedListening);
  $("#stats-storage-used").textContent = formatBytes(capacity.usedBytes);

  const hasAnyListening = allDays.some(([, day]) => (day.listeningMs || 0) > 0 || (day.plays || 0) > 0);
  const hasRangeListening = selectedDays.some(([, day]) => (day.listeningMs || 0) > 0 || (day.plays || 0) > 0);
  $("#stats-listening-empty").hidden = hasAnyListening;
  $("#stats-listening-data").hidden = !hasAnyListening;
  if (hasAnyListening) {
    $("#stats-chart-wrap").hidden = !hasRangeListening;
    $("#stats-chart-empty").hidden = hasRangeListening;
    if (hasRangeListening) renderChart(selectedDays);
    if (!hasRangeListening) { $("#stats-chart").replaceChildren(); $("#stats-chart-labels").replaceChildren(); }
    const weekStartDate = new Date(); weekStartDate.setHours(0, 0, 0, 0); weekStartDate.setDate(weekStartDate.getDate() - 6);
    const weekDays = matchingDays(stats, localKey(weekStartDate));
    $("#stats-week-plays").textContent = number.format(sum(weekDays, "plays"));
    $("#stats-streak").textContent = listeningStreak(allDays);
    const weekdayMinutes = Array(7).fill(0);
    selectedDays.forEach(([key, day]) => { weekdayMinutes[new Date(`${key}T12:00:00`).getDay()] += day.listeningMs || 0; });
    const bestDay = Math.max(...weekdayMinutes);
    $("#stats-favorite-day").textContent = bestDay ? new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(new Date(2024, 0, 7 + weekdayMinutes.indexOf(bestDay))) : "—";
    const playCounts = countByMedia(selectedDays);
    const mediaById = new Map(records.map((record) => [record.id, record]));
    const mostPlayed = [...playCounts].sort((a, b) => b[1] - a[1]);
    renderList("#stats-top-tracks", mostPlayed.slice(0, 5).map(([id, count]) => {
      const record = mediaById.get(id); return record && { primary: record.title || record.name.replace(/\.[^.]+$/, ""), secondary: `${record.artist || "Unknown artist"} · ${number.format(count)} plays` };
    }).filter(Boolean), "No played tracks in this period.");
    const artistCounts = new Map();
    mostPlayed.forEach(([id, count]) => { const artist = mediaById.get(id)?.artist?.trim(); if (artist) artistCounts.set(artist, (artistCounts.get(artist) || 0) + count); });
    renderList("#stats-top-artists", [...artistCounts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([artist, count]) => ({ primary: artist, secondary: `${number.format(count)} plays` })), "No artist play data in this period.");
    const albumCounts = new Map();
    mostPlayed.forEach(([id, count]) => { const record = mediaById.get(id); const album = record?.album?.trim(); if (album) { const artist = record.artist || "Unknown artist"; const key = `${album}\u0000${artist}`; albumCounts.set(key, (albumCounts.get(key) || 0) + count); } });
    renderList("#stats-albums", [...albumCounts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key, count]) => { const [album, artist] = key.split("\u0000"); return { primary: album, secondary: `${artist} · ${number.format(count)} plays` }; }), "Album favorites appear after you play tagged music.");
  }
  const genreCounts = new Map();
  records.forEach((record) => String(record.genre || "").split(/[;,/]/).map((genre) => genre.trim()).filter(Boolean).forEach((genre) => genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1)));
  renderList("#stats-genres", [...genreCounts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([genre, count]) => ({ primary: genre, secondary: `${number.format(count)} ${count === 1 ? "track" : "tracks"}` })), "Add genre tags to see your library mix.");
  renderList("#stats-recent-added", records.slice(0, 5).map((record) => ({ primary: record.title || record.name.replace(/\.[^.]+$/, ""), secondary: record.artist || new Date(record.importedAt).toLocaleDateString() })), "Your newest additions will show here.");
  $("#stats-downloads").textContent = number.format(sum(selectedDays, "downloads"));
  $("#stats-tag-edits").textContent = number.format(sum(selectedDays, "tagEdits"));
  $("#stats-batch-jobs").textContent = number.format(sum(selectedDays, "batchJobs"));
  $("#stats-failed-jobs").textContent = number.format(sum(selectedDays, "failedJobs"));
  renderErrors(stats, selectedDays);
}

export function initializeStats() {
  document.querySelectorAll("[data-stats-range]").forEach((button) => button.addEventListener("click", () => {
    range = button.dataset.statsRange;
    document.querySelectorAll("[data-stats-range]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    renderStats().catch(showError);
  }));
  function showError(error) { $("#stats-status").textContent = error.message || "Could not load your local stats."; }
  const refresh = () => {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => { refreshQueued = false; renderStats().catch(showError); });
  };
  window.addEventListener("puffin:stats-updated", refresh);
  window.addEventListener("puffin:library-updated", refresh);
  window.addEventListener("puffin:metadata-updated", refresh);
  window.addEventListener("puffin:tab-changed", (event) => { if (event.detail === "stats") refresh(); });
  renderStats().catch(showError);
}
