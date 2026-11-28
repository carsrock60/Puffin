"use strict";

const { app, BrowserWindow, ipcMain, net, protocol, shell } = require("electron");
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");

const { DownloadManager } = require("./download-manager");
const { UpdateManager } = require("./update-manager");

const APP_ORIGIN = "puffin://app";
const SERVICE_ORIGIN = String(process.env.PUFFIN_SERVICE_ORIGIN || "https://puffin-iota.vercel.app").replace(/\/$/, "");
const WEB_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, "web")
  : path.join(__dirname, "..", "..", "web", "dist");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "puffin",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, codeCache: true },
  },
  {
    scheme: "puffin-media",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

app.setName("Puffin");
if (process.env.PUFFIN_USER_DATA) {
  const userData = path.resolve(process.env.PUFFIN_USER_DATA);
  app.setPath("userData", userData);
  app.setPath("sessionData", userData);
}
if (process.platform === "win32") app.setAppUserModelId("com.puffin.player");

const downloads = new DownloadManager();
const updates = new UpdateManager();

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function broadcast(channel, payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

downloads.on("progress", (payload) => broadcast("puffin:downloads:progress", payload));
updates.on("status", (payload) => broadcast("puffin:updates:status", payload));

function notFound(message = "Not found") {
  return new Response(message, { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function missingWebBuild() {
  return new Response(
    "<!doctype html><meta charset=\"utf-8\"><title>Puffin</title><body style=\"font:15px system-ui;padding:40px;background:#111;color:#eee\"><h1>Puffin is missing its web build</h1><p>Run <code>npm run build:web</code> and restart the desktop app.</p></body>",
    { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

async function serveAppFile(request) {
  const url = new URL(request.url);
  if (url.hostname !== "app") return notFound();
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (pathname === "/" || pathname === "") pathname = "/index.html";

  const candidate = path.resolve(WEB_ROOT, `.${pathname}`);
  const rootPrefix = WEB_ROOT.endsWith(path.sep) ? WEB_ROOT : `${WEB_ROOT}${path.sep}`;
  if (candidate !== WEB_ROOT && !candidate.startsWith(rootPrefix)) {
    return new Response("Forbidden", { status: 403 });
  }

  let filePath = candidate;
  let stat = await fsp.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    if (path.extname(pathname)) return notFound();
    filePath = path.join(WEB_ROOT, "index.html");
    stat = await fsp.stat(filePath).catch(() => null);
  }
  if (!stat?.isFile()) return missingWebBuild();

  const headers = {
    "Content-Type": contentTypeFor(filePath),
    "Content-Length": String(stat.size),
    "Cache-Control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  };
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  const body = await fsp.readFile(filePath);
  return new Response(body, { status: 200, headers });
}

async function proxyApi(request) {
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, SERVICE_ORIGIN);
  const headers = new Headers(request.headers);
  for (const name of ["host", "origin", "referer", "content-length", "connection", "accept-encoding"]) {
    headers.delete(name);
  }
  const init = { method: request.method, headers, redirect: "follow" };
  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = Buffer.from(await request.arrayBuffer());
  }
  try {
    const response = await net.fetch(target.toString(), init);
    const responseHeaders = new Headers(response.headers);
    for (const name of ["content-encoding", "content-length", "transfer-encoding"]) responseHeaders.delete(name);
    const body = request.method === "HEAD" ? null : Buffer.from(await response.arrayBuffer());
    return new Response(body, { status: response.status, headers: responseHeaders });
  } catch (error) {
    console.warn("[Puffin] Online service unavailable:", error.message);
    return new Response(JSON.stringify({ error: "Puffin's online service is unavailable. Check this device's internet connection." }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}

async function serveMedia(request) {
  const url = new URL(request.url);
  if (url.hostname !== "download") return notFound();
  let jobId;
  try {
    jobId = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const filePath = downloads.getFilePath(jobId);
  if (!filePath) return notFound("Download is not ready");
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat?.isFile()) return notFound("Download is not ready");

  const name = downloads.getMediaName(jobId);
  const asciiName = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const headers = {
    "Content-Type": downloads.getMediaMime(jobId),
    "Content-Length": String(stat.size),
    "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Disposition, Content-Length, Content-Type",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cache-Control": "no-store",
  };
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  const stream = fs.createReadStream(filePath);
  return new Response(Readable.toWeb(stream), { status: 200, headers });
}

function openExternal(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ""));
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    shell.openExternal(parsed.toString());
    return true;
  } catch {
    return false;
  }
}

function registerIpc() {
  ipcMain.handle("puffin:app-info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    serviceOrigin: SERVICE_ORIGIN,
  }));
  ipcMain.handle("puffin:open-external", (_event, url) => openExternal(url));

  ipcMain.handle("puffin:downloads:search", (_event, query) => downloads.search(query));
  ipcMain.handle("puffin:downloads:start", (_event, options) => downloads.start(options));
  ipcMain.handle("puffin:downloads:cancel", (_event, jobId) => downloads.cancel(jobId));
  ipcMain.handle("puffin:downloads:complete", (_event, jobId) => downloads.complete(jobId));
  ipcMain.handle("puffin:downloads:status", (_event, jobId) => downloads.getStatus(jobId));
  ipcMain.handle("puffin:downloads:subtitles", (_event, jobId) => downloads.getSubtitles(jobId));
  ipcMain.handle("puffin:downloads:info", () => downloads.getInfo());
  ipcMain.handle("puffin:downloads:clear-temp", () => downloads.clearTemp());

  ipcMain.handle("puffin:updates:get", () => updates.getState());
  ipcMain.handle("puffin:updates:check", () => updates.check());
  ipcMain.handle("puffin:updates:download", () => updates.download());
  ipcMain.handle("puffin:updates:install", () => updates.install());
  ipcMain.handle("puffin:updates:auto", (_event, enabled) => updates.setAutoCheck(enabled));
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 940,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: "#101214",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  window.once("ready-to-show", () => window.show());
  window.loadURL(`${APP_ORIGIN}/`).catch((error) => {
    console.error("[Puffin] Could not load the app:", error);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(`${APP_ORIGIN}/`) || url === APP_ORIGIN) return;
    event.preventDefault();
    openExternal(url);
  });
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      await downloads.initialize();
    } catch (error) {
      console.error("[Puffin] Download engine initialization failed:", error);
    }
    protocol.handle("puffin", (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) return proxyApi(request);
      return serveAppFile(request);
    });
    protocol.handle("puffin-media", serveMedia);

    registerIpc();
    createWindow();
    updates.initialize();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  downloads.dispose();
  updates.dispose();
});

module.exports = { downloads, updates };
