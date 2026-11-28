"use strict";

const path = require("node:path");

const MEDIA_EXTENSIONS = new Set([
  ".m4a", ".mp3", ".aac", ".opus", ".ogg", ".oga", ".flac", ".wav",
  ".mp4", ".m4v", ".mov", ".webm", ".ogv",
]);

const MIME_TYPES = {
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".aac": "audio/aac",
  ".opus": "audio/ogg",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
};

function cleanQuery(value, maxLength = 160) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeSubtitleLanguage(value) {
  const cleaned = String(value || "en").trim().toLowerCase();
  const match = cleaned.match(/^([a-z]{2,3})(?:[-_]([a-z0-9]{2,8}))?$/);
  if (!match) return { primary: "en", list: "en" };
  const primary = match[2] ? `${match[1]}-${match[2]}` : match[1];
  return { primary, list: primary === match[1] ? primary : `${primary},${match[1]}` };
}

function buildSearchArgs(query) {
  const cleaned = cleanQuery(query);
  if (!cleaned) throw new Error("Enter something to search for.");
  return [
    "--no-warnings",
    "--flat-playlist",
    "--dump-single-json",
    "--skip-download",
    "--socket-timeout", "30",
    "--js-runtimes", "node",
    "--playlist-end", "12",
    `ytsearch12:${cleaned}`,
  ];
}

function buildDownloadArgs({ target, kind, height, subtitleLanguage, tempDir, ffmpegPath }) {
  const cleaned = cleanQuery(target, 2000);
  if (!cleaned) throw new Error("Enter a YouTube link or search phrase.");
  if (kind !== "audio" && kind !== "video") throw new Error("Choose audio or video.");

  const outputTemplate = path.join(tempDir, "%(title).120B [%(id)s].%(ext)s");
  const args = [
    "--no-warnings",
    "--newline",
    "--no-playlist",
    "--no-mtime",
    "--socket-timeout", "30",
    "--retries", "3",
    "--fragment-retries", "3",
    "--js-runtimes", "node",
    "--ffmpeg-location", ffmpegPath,
    "--output", outputTemplate,
    "--print-to-file", "after_move:filepath", path.join(tempDir, "final-path.txt"),
  ];

  if (kind === "video") {
    const maxHeight = Number.isInteger(Number(height)) ? Number(height) : 720;
    args.push(
      "-f",
      `bv*[height<=${maxHeight}][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=${maxHeight}][ext=mp4]/bv*[height<=${maxHeight}]+ba/b[height<=${maxHeight}]`,
      "--merge-output-format", "mp4/webm",
    );
    const language = normalizeSubtitleLanguage(subtitleLanguage);
    args.push(
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs", language.list,
      "--sub-format", "vtt",
      "--convert-subs", "vtt",
    );
  } else {
    args.push("-f", "ba[ext=m4a]/ba[ext=mp3]/ba[ext=opus]/ba");
  }

  args.push("--", cleaned);
  return args;
}

function parseProgressLine(line) {
  const text = String(line || "");
  const percentMatch = text.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i);
  if (!percentMatch) return null;
  const sizeMatch = text.match(/%\s+of\s+~?\s*([\d.]+)\s*([KMGTP]?i?B)/i);
  const speedMatch = text.match(/\s+at\s+(\S+)/i);
  const etaMatch = text.match(/\s+ETA\s+([\d:]+)/i);
  return {
    progress: Math.max(0, Math.min(100, Number(percentMatch[1]))),
    size: sizeMatch ? `${sizeMatch[1]}${sizeMatch[2]}` : "",
    speed: speedMatch && !/^unknown$/i.test(speedMatch[1]) ? speedMatch[1] : "",
    eta: etaMatch ? etaMatch[1] : "",
  };
}

function parseSearchPayload(payload) {
  const entries = Array.isArray(payload?.entries)
    ? payload.entries
    : Array.isArray(payload) ? payload : [];
  return entries.map((entry) => {
    const id = String(entry?.id || "");
    const url = String(entry?.webpage_url || entry?.url || (id ? `https://www.youtube.com/watch?v=${id}` : ""));
    const title = String(entry?.title || "").trim();
    const channel = String(entry?.channel || entry?.uploader || entry?.playlist_uploader || "").trim();
    const duration = Number(entry?.duration);
    const thumbnails = Array.isArray(entry?.thumbnails) ? entry.thumbnails : [];
    const thumbnail = String(
      entry?.thumbnail
      || thumbnails[thumbnails.length - 1]?.url
      || (id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : ""),
    );
    return {
      id,
      url,
      title,
      channel,
      duration: Number.isFinite(duration) && duration >= 0 ? duration : null,
      thumbnail,
    };
  }).filter((video) => video.url && video.title).slice(0, 12);
}

function selectMediaFile(files) {
  const media = files
    .map((file) => path.basename(String(file)))
    .filter((name) => !/\.(part|ytdl|tmp|vtt|json|jpg|jpeg|png|webp)$/i.test(name))
    .filter((name) => MEDIA_EXTENSIONS.has(path.extname(name).toLowerCase()));
  if (!media.length) return "";
  const preferred = media.find((name) => /\.(mp4|m4a)$/i.test(name));
  return preferred || media[0];
}

function pickSubtitleFile(files, language) {
  const subtitles = files
    .map((file) => path.basename(String(file)))
    .filter((name) => /\.vtt$/i.test(name));
  if (!subtitles.length) return "";
  const primary = normalizeSubtitleLanguage(language).primary.toLowerCase();
  const primaryMatch = subtitles.find((name) => name.toLowerCase().endsWith(`.${primary}.vtt`));
  if (primaryMatch) return primaryMatch;
  const english = subtitles.find((name) => name.toLowerCase().endsWith(".en.vtt"));
  return english || subtitles[0];
}

function subtitleLanguageFromFile(filename, fallback = "en") {
  const match = path.basename(String(filename || "")).match(/\.([a-z]{2,3}(?:-[a-z0-9]{2,8})?)\.vtt$/i);
  return match ? match[1] : normalizeSubtitleLanguage(fallback).primary;
}

function mediaMimeFor(filename, kind = "") {
  const extension = path.extname(String(filename || "")).toLowerCase();
  if (kind === "audio" && extension === ".webm") return "audio/webm";
  if (kind === "audio" && extension === ".mp4") return "audio/mp4";
  return MIME_TYPES[extension] || "application/octet-stream";
}

module.exports = {
  buildDownloadArgs,
  buildSearchArgs,
  cleanQuery,
  mediaMimeFor,
  normalizeSubtitleLanguage,
  parseProgressLine,
  parseSearchPayload,
  pickSubtitleFile,
  selectMediaFile,
  subtitleLanguageFromFile,
};
