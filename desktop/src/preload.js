"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  if (typeof callback !== "function") return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

async function invoke(channel, ...args) {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (error) {
    const message = String(error?.message || error || "Puffin could not complete that action.")
      .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "")
      .replace(/^Error:\s*/, "");
    const cleaned = new Error(message || "Puffin could not complete that action.");
    throw cleaned;
  }
}

contextBridge.exposeInMainWorld("puffinDesktop", {
  isDesktop: true,
  platform: process.platform || "",
  arch: process.arch || "",
  app: {
    getInfo: () => invoke("puffin:app-info"),
  },
  downloads: {
    search: (query) => invoke("puffin:downloads:search", query),
    start: (options) => invoke("puffin:downloads:start", options),
    cancel: (jobId) => invoke("puffin:downloads:cancel", jobId),
    complete: (jobId) => invoke("puffin:downloads:complete", jobId),
    getStatus: (jobId) => invoke("puffin:downloads:status", jobId),
    getSubtitles: (jobId) => invoke("puffin:downloads:subtitles", jobId),
    getInfo: () => invoke("puffin:downloads:info"),
    clearTemp: () => invoke("puffin:downloads:clear-temp"),
    onProgress: (callback) => subscribe("puffin:downloads:progress", callback),
  },
  updates: {
    getState: () => invoke("puffin:updates:get"),
    check: () => invoke("puffin:updates:check"),
    download: () => invoke("puffin:updates:download"),
    install: () => invoke("puffin:updates:install"),
    setAutoCheck: (enabled) => invoke("puffin:updates:auto", Boolean(enabled)),
    onStatus: (callback) => subscribe("puffin:updates:status", callback),
  },
  openExternal: (url) => invoke("puffin:open-external", url),
});
