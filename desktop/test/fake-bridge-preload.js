"use strict";

const { contextBridge } = require("electron");

const status = {
  supported: true,
  state: "available",
  currentVersion: "1.0.0",
  availableVersion: "1.1.0",
  progress: 0,
  manual: true,
  autoCheck: true,
  releaseUrl: "https://github.com/carsrock60/Puffin/releases/latest",
  message: "Puffin 1.1.0 is available. Download the new installer from GitHub.",
};

contextBridge.exposeInMainWorld("puffinDesktop", {
  isDesktop: true,
  platform: "darwin",
  arch: "arm64",
  openExternal: async () => true,
  updates: {
    getState: async () => status,
    check: async () => status,
    download: async () => status,
    install: async () => false,
    setAutoCheck: async () => status,
    onStatus: () => {},
  },
});
