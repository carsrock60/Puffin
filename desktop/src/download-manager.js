"use strict";

const { app, net } = require("electron");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const ffmpegStatic = require("ffmpeg-static");

const {
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
} = require("./download-plan");

const ACTIVE_STATES = new Set(["queued", "starting", "downloading", "converting"]);
const ENGINE_RELEASE_BASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";

function unpackedPath(value) {
  if (!value) return "";
  return value.includes("app.asar") ? value.replace("app.asar", "app.asar.unpacked") : value;
}

function cancellationError() {
  const error = new Error("Download cancelled.");
  error.cancelled = true;
  return error;
}

function stripAnsi(value) {
  return String(value || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function friendlyError(value, fallback) {
  const text = stripAnsi(value || "").trim();
  if (!text) return fallback;
  if (/Sign in to confirm|confirm you(?:'| a)re not a bot|not a bot/i.test(text)) {
    return "YouTube asked Puffin to confirm this device. Try again in a moment, or update the download engine.";
  }
  if (/getaddrinfo|ENOTFOUND|EAI_AGAIN|Unable to download webpage|Network is unreachable|timed out/i.test(text)) {
    return "Puffin could not reach YouTube. Check this device's internet connection and try again.";
  }
  if (/No supported JavaScript runtime|JavaScript runtime/i.test(text)) {
    return "Puffin's download engine could not start its JavaScript runtime. Restart Puffin and try again.";
  }
  if (/Requested format is not available|No video formats found/i.test(text)) {
    return "That quality is not available for this video. Choose a different quality and try again.";
  }
  if (/Video unavailable|Private video|This video is unavailable|members-only/i.test(text)) {
    return "That video is not available for download. It may be private, removed, or age restricted.";
  }
  return text.replace(/^ERROR:\s*/i, "").split(/\r?\n/).pop().slice(0, 500) || fallback;
}

class DownloadManager extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map();
    this.activeJobId = null;
    this.enginePromise = null;
    this.engineVersion = "";
    this.binDir = "";
    this.tempRoot = "";
    this.ffmpegPath = unpackedPath(ffmpegStatic);
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    this.binDir = path.join(app.getPath("userData"), "bin");
    this.tempRoot = path.join(app.getPath("temp"), "puffin-downloads");
    await fsp.mkdir(this.binDir, { recursive: true });
    await fsp.mkdir(this.tempRoot, { recursive: true });
    if (!this.ffmpegPath || !fs.existsSync(this.ffmpegPath)) {
      throw new Error("Puffin's bundled media tools are missing. Reinstall Puffin and try again.");
    }
    await this._ensureNodeRuntime();
    this.initialized = true;
    this.cleanupStale().catch(() => {});
  }

  async _ready() {
    if (!this.initialized) await this.initialize();
  }

  _binaryName() {
    return process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  }

  _binaryPath() {
    return path.join(this.binDir, this._binaryName());
  }

  _downloadUrl() {
    if (process.platform === "win32") return `${ENGINE_RELEASE_BASE}/yt-dlp.exe`;
    if (process.platform === "darwin") return `${ENGINE_RELEASE_BASE}/yt-dlp_macos`;
    return `${ENGINE_RELEASE_BASE}/yt-dlp_linux`;
  }

  async _ensureNodeRuntime() {
    const target = path.join(this.binDir, process.platform === "win32" ? "node.exe" : "node");
    try { await fsp.unlink(target); } catch { /* runtime is rewritten on every launch */ }
    try {
      if (process.platform === "win32") {
        try {
          await fsp.link(process.execPath, target);
        } catch {
          await fsp.copyFile(process.execPath, target);
        }
      } else {
        try {
          await fsp.symlink(process.execPath, target, "file");
        } catch {
          await fsp.writeFile(target, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"\n`, { mode: 0o755 });
          await fsp.chmod(target, 0o755);
        }
      }
    } catch {
      // yt-dlp can still use a system Node installation when the wrapper cannot be created.
    }
  }

  _env() {
    return {
      ...process.env,
      PATH: `${this.binDir}${path.delimiter}${process.env.PATH || ""}`,
      ELECTRON_RUN_AS_NODE: "1",
      PYTHONIOENCODING: "utf-8",
      NO_COLOR: "1",
    };
  }

  _emit(job, force = false) {
    const now = Date.now();
    if (!force && now - (job.lastEmittedAt || 0) < 220) return;
    job.lastEmittedAt = now;
    this.emit("progress", this.getStatus(job.id));
  }

  _publicJob(job) {
    if (!job) return null;
    return {
      jobId: job.id,
      status: job.status,
      stage: job.stage,
      progress: Math.max(0, Math.min(100, Number(job.progress) || 0)),
      speed: job.speed || "",
      eta: job.eta || "",
      error: job.error || "",
      filename: job.filename || "",
      size: job.size || 0,
      mime: job.mime || "",
      kind: job.kind,
      height: job.height ?? null,
      subtitlesAvailable: Boolean(job.subtitlePath),
      subtitleLanguage: job.subtitleLanguage || "",
      subtitleSize: job.subtitleSize || 0,
    };
  }

  getStatus(jobId) {
    return this._publicJob(this.jobs.get(String(jobId || "")));
  }

  getJob(jobId) {
    return this.jobs.get(String(jobId || "")) || null;
  }

  async _checkBinary(binary) {
    try {
      const result = await this._capture(binary, ["--version"], 15000);
      const version = String(result.stdout || "").trim().split(/\s+/)[0];
      if (result.code === 0 && /^\d{4}\.\d{2}\.\d{2}/.test(version)) {
        this.engineVersion = version;
        return version;
      }
    } catch {
      // A missing or partially downloaded engine is replaced below.
    }
    return "";
  }

  async ensureYtDlp() {
    await this._ready();
    if (!this.enginePromise) {
      this.enginePromise = this._installYtDlp().catch((error) => {
        this.enginePromise = null;
        throw error;
      });
    }
    return this.enginePromise;
  }

  async _installYtDlp() {
    const binary = this._binaryPath();
    if (fs.existsSync(binary)) {
      const version = await this._checkBinary(binary);
      if (version) return binary;
      try { await fsp.unlink(binary); } catch { /* replaced below */ }
    }

    const response = await net.fetch(this._downloadUrl(), { redirect: "follow" });
    if (!response.ok) {
      throw new Error(`Puffin could not download its media engine (${response.status}). Check your internet connection and try again.`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length < 500000) throw new Error("Puffin's media engine download was incomplete. Try again.");

    const temporary = `${binary}.download`;
    await fsp.writeFile(temporary, data);
    try { await fsp.unlink(binary); } catch { /* first install */ }
    await fsp.rename(temporary, binary);
    if (process.platform !== "win32") await fsp.chmod(binary, 0o755);

    const version = await this._checkBinary(binary);
    if (!version) {
      try { await fsp.unlink(binary); } catch { /* best effort */ }
      throw new Error("Puffin's media engine did not start correctly. Restart Puffin and try again.");
    }
    return binary;
  }

  _capture(binary, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const child = spawn(binary, args, {
        env: this._env(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("The on-device downloader took too long to respond."));
      }, timeoutMs);
      child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }

  async search(query) {
    await this._ready();
    const cleaned = cleanQuery(query);
    if (!cleaned) throw new Error("Enter a search term first.");
    const binary = await this.ensureYtDlp();
    let result;
    try {
      result = await this._capture(binary, buildSearchArgs(cleaned), 120000);
    } catch (error) {
      throw new Error(friendlyError(error.message, "YouTube search failed. Check your internet connection."));
    }
    if (result.code !== 0) {
      throw new Error(friendlyError(result.stderr, "YouTube search failed. Try a different search."));
    }
    let payload;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      throw new Error("YouTube returned an unexpected search result. Try again.");
    }
    return parseSearchPayload(payload);
  }

  async start(options) {
    await this._ready();
    const target = cleanQuery(options?.target, 2000);
    const kind = options?.kind === "video" ? "video" : "audio";
    if (!target) throw new Error("Enter a YouTube link or search phrase.");
    if (this.activeJobId) {
      const active = this.jobs.get(this.activeJobId);
      if (active && ACTIVE_STATES.has(active.status)) {
        throw new Error("Another download is already running on this device. Wait for it to finish or cancel it.");
      }
    }

    const requestedHeight = Number(options?.videoHeight);
    const height = kind === "video" && Number.isInteger(requestedHeight) && requestedHeight >= 144 && requestedHeight <= 4320
      ? requestedHeight
      : 720;
    const subtitleLanguage = normalizeSubtitleLanguage(options?.subtitleLanguage || "en").primary;
    const id = crypto.randomUUID();
    const job = {
      id,
      kind,
      target,
      requestedHeight: kind === "video" ? height : null,
      subtitleLanguage,
      status: "queued",
      stage: "preparing",
      progress: 0,
      speed: "",
      eta: "",
      error: "",
      filename: "",
      size: 0,
      mime: "",
      height: null,
      subtitlePath: "",
      subtitleSize: 0,
      tempDir: path.join(this.tempRoot, id),
      createdAt: Date.now(),
      cancelled: false,
      child: null,
    };
    this.jobs.set(id, job);
    this.activeJobId = id;
    this._emit(job, true);
    this._run(job).catch((error) => {
      console.error("[Puffin download] Unexpected failure:", error);
    });
    return { jobId: id };
  }

  async _run(job) {
    try {
      if (job.cancelled) throw cancellationError();
      job.status = "starting";
      job.stage = "preparing";
      this._emit(job, true);

      const binary = await this.ensureYtDlp();
      if (job.cancelled) throw cancellationError();
      await fsp.mkdir(job.tempDir, { recursive: true });

      job.status = "downloading";
      job.stage = "resolving";
      this._emit(job, true);
      const args = buildDownloadArgs({
        target: job.target,
        kind: job.kind,
        height: job.requestedHeight,
        subtitleLanguage: job.subtitleLanguage,
        tempDir: job.tempDir,
        ffmpegPath: this.ffmpegPath,
      });
      const result = await this._spawnDownload(binary, args, job);
      if (job.cancelled) throw cancellationError();
      if (result.code !== 0) {
        throw new Error(friendlyError(job.lastError || result.error, "The on-device download failed."));
      }

      job.status = "converting";
      job.stage = "processing";
      job.progress = 100;
      this._emit(job, true);

      const names = await fsp.readdir(job.tempDir);
      const mediaName = selectMediaFile(names);
      if (!mediaName) throw new Error("The download finished without a playable media file.");
      const mediaPath = path.join(job.tempDir, mediaName);
      const stat = await fsp.stat(mediaPath);
      if (!stat.isFile() || stat.size <= 0) throw new Error("The downloaded media file is empty.");
      if (job.kind === "video" && /\.(mkv|avi|flv|ts)$/i.test(mediaName)) {
        throw new Error("YouTube returned a video container that Puffin cannot play. Choose a different quality.");
      }

      let height = null;
      if (job.kind === "video") {
        height = await this._probeHeight(mediaPath);
        if (!Number.isInteger(height) || height <= 0) {
          throw new Error("Puffin could not verify the downloaded video's resolution.");
        }
      }

      const subtitleName = job.kind === "video" ? pickSubtitleFile(names, job.subtitleLanguage) : "";
      if (subtitleName) {
        const subtitlePath = path.join(job.tempDir, subtitleName);
        const subtitleStat = await fsp.stat(subtitlePath).catch(() => null);
        if (subtitleStat?.isFile()) {
          job.subtitlePath = subtitlePath;
          job.subtitleSize = subtitleStat.size;
          job.subtitleLanguage = subtitleLanguageFromFile(subtitleName, job.subtitleLanguage);
        }
      }

      job.filePath = mediaPath;
      job.filename = mediaName;
      job.size = stat.size;
      job.mime = mediaMimeFor(mediaName, job.kind);
      job.height = height;
      job.status = "ready";
      job.stage = "completed";
      job.progress = 100;
      job.speed = "";
      job.eta = "";
      this._emit(job, true);
    } catch (error) {
      if (job.cancelled || error.cancelled) {
        job.status = "cancelled";
        job.stage = "cancelled";
        job.error = "";
      } else {
        job.status = "failed";
        job.stage = "failed";
        job.error = error.message || "The on-device download failed.";
      }
      job.speed = "";
      job.eta = "";
      this._emit(job, true);
      await this._removeTemp(job);
    } finally {
      if (this.activeJobId === job.id) this.activeJobId = null;
    }
  }

  _handleLine(job, rawLine) {
    const line = stripAnsi(rawLine).trim();
    if (!line) return;

    if (/^ERROR:/i.test(line)) {
      job.lastError = line.replace(/^ERROR:\s*/i, "");
      return;
    }
    if (/\[download\]\s+Destination/i.test(line)) {
      job.status = "downloading";
      job.stage = "downloading";
      this._emit(job);
    } else if (/^\[(Merger|ExtractAudio|VideoRemuxer|VideoConvertor|FixupM3u8|SubtitlesConvertor|EmbedSubtitle)\]/i.test(line)) {
      job.status = "converting";
      job.stage = "processing";
      this._emit(job);
    } else if (/^\[(youtube|info|generic)\]/i.test(line) && job.stage === "resolving") {
      job.stage = "resolving";
      this._emit(job);
    }

    const progress = parseProgressLine(line);
    if (!progress) return;
    job.status = "downloading";
    job.stage = "downloading";
    job.progress = progress.progress;
    if (progress.speed) job.speed = progress.speed;
    if (progress.eta) job.eta = progress.eta;
    this._emit(job);
  }

  _spawnDownload(binary, args, job) {
    return new Promise((resolve) => {
      let settled = false;
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let stderrText = "";
      const child = spawn(binary, args, {
        env: this._env(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      job.child = child;

      const consume = (chunk, isError) => {
        const text = chunk.toString("utf8");
        if (isError) stderrText = (stderrText + text).slice(-12000);
        let buffer = isError ? stderrBuffer + text : stdoutBuffer + text;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        if (isError) stderrBuffer = buffer;
        else stdoutBuffer = buffer;
        for (const line of lines) this._handleLine(job, line);
      };
      child.stdout.on("data", (chunk) => consume(chunk, false));
      child.stderr.on("data", (chunk) => consume(chunk, true));
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        job.child = null;
        resolve({ code: -1, error: error.message });
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        job.child = null;
        if (stdoutBuffer) this._handleLine(job, stdoutBuffer);
        if (stderrBuffer) this._handleLine(job, stderrBuffer);
        resolve({ code, error: job.lastError || stderrText.trim().split(/\r?\n/).pop() || "" });
      });
    });
  }

  _probeHeight(filePath) {
    if (!this.ffmpegPath) return Promise.resolve(null);
    return new Promise((resolve) => {
      const child = spawn(this.ffmpegPath, [
        "-hide_banner",
        "-nostdin",
        "-i", filePath,
        "-map", "0:v:0",
        "-frames:v", "1",
        "-f", "null",
        "-",
      ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      let output = "";
      let settled = false;
      const finish = (height) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(height);
      };
      const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
      child.stderr.on("data", (chunk) => { output = (output + chunk.toString("utf8")).slice(-20000); });
      child.once("error", () => finish(null));
      child.once("close", () => {
        const match = output.match(/(?:^|[,\s])(\d{2,5})x(\d{2,5})(?:[,\s]|$)/m);
        finish(match ? Number.parseInt(match[2], 10) : null);
      });
    });
  }

  async cancel(jobId) {
    const job = this.jobs.get(String(jobId || ""));
    if (!job) return false;
    job.cancelled = true;
    if (job.child) {
      job.child.kill("SIGTERM");
      const child = job.child;
      setTimeout(() => {
        if (job.child === child) child.kill("SIGKILL");
      }, 5000).unref?.();
    } else if (!["ready", "failed", "cancelled"].includes(job.status)) {
      job.status = "cancelled";
      job.stage = "cancelled";
      this._emit(job, true);
      await this._removeTemp(job);
    }
    if (this.activeJobId === job.id) this.activeJobId = null;
    return true;
  }

  async complete(jobId) {
    const job = this.jobs.get(String(jobId || ""));
    if (!job || job.status !== "ready") return false;
    await this._removeTemp(job);
    this.jobs.delete(job.id);
    if (this.activeJobId === job.id) this.activeJobId = null;
    return true;
  }

  async getSubtitles(jobId) {
    const job = this.jobs.get(String(jobId || ""));
    if (!job?.subtitlePath) return null;
    const stat = await fsp.stat(job.subtitlePath).catch(() => null);
    if (!stat?.isFile() || stat.size > 2 * 1024 * 1024) return null;
    const text = await fsp.readFile(job.subtitlePath, "utf8");
    return { text, language: job.subtitleLanguage || "en" };
  }

  getFilePath(jobId) {
    const job = this.jobs.get(String(jobId || ""));
    if (!job?.filePath || job.status !== "ready") return "";
    return job.filePath;
  }

  getMediaName(jobId) {
    const job = this.jobs.get(String(jobId || ""));
    return job?.filename || "puffin-download";
  }

  getMediaMime(jobId) {
    const job = this.jobs.get(String(jobId || ""));
    return job?.mime || "application/octet-stream";
  }

  async _removeTemp(job) {
    job.filePath = "";
    job.subtitlePath = "";
    if (!job.tempDir) return;
    try { await fsp.rm(job.tempDir, { recursive: true, force: true }); } catch { /* retried on next launch */ }
  }

  async cleanupStale() {
    await this._ready();
    const cutoff = Date.now() - 12 * 60 * 60 * 1000;
    let entries = [];
    try { entries = await fsp.readdir(this.tempRoot, { withFileTypes: true }); } catch { return 0; }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || this.jobs.has(entry.name)) continue;
      const full = path.join(this.tempRoot, entry.name);
      const stat = await fsp.stat(full).catch(() => null);
      if (stat && stat.mtimeMs > cutoff) continue;
      try {
        await fsp.rm(full, { recursive: true, force: true });
        removed += 1;
      } catch { /* retried later */ }
    }
    return removed;
  }

  async clearTemp() {
    await this._ready();
    const entries = await fsp.readdir(this.tempRoot, { withFileTypes: true }).catch(() => []);
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Keep folders for jobs the renderer is still saving or retrying.
      if (this.jobs.has(entry.name)) continue;
      try {
        await fsp.rm(path.join(this.tempRoot, entry.name), { recursive: true, force: true });
        removed += 1;
      } catch { /* retried later */ }
    }
    return { removed };
  }

  async getInfo() {
    await this._ready();
    let version = "";
    if (fs.existsSync(this._binaryPath())) version = await this._checkBinary(this._binaryPath());
    return {
      engine: version ? `yt-dlp ${version}` : "yt-dlp (installs on first download)",
      installed: Boolean(version),
      ffmpeg: Boolean(this.ffmpegPath && fs.existsSync(this.ffmpegPath)),
      folder: this.tempRoot,
    };
  }

  dispose() {
    for (const job of this.jobs.values()) {
      try { job.child?.kill("SIGKILL"); } catch { /* already stopped */ }
    }
  }
}

module.exports = { DownloadManager };
