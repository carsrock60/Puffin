"use strict";

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const output = path.join(__dirname, "..", ".home", "update-ui");

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "fake-bridge-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try {
    await window.loadURL("http://127.0.0.1:5173/");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const result = await window.webContents.executeJavaScript(`(async () => {
      document.querySelector("#settings-open")?.click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      document.querySelector('[data-settings-section="updates"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      return {
        dotHidden: document.querySelector("#settings-update-dot")?.hidden ?? null,
        navHidden: document.querySelector('[data-settings-section="updates"]')?.hidden ?? null,
        panelHidden: document.querySelector('[data-settings-panel="updates"]')?.hidden ?? null,
        state: document.querySelector("#settings-update-state")?.textContent || "",
        downloadText: document.querySelector("#settings-update-download")?.textContent || "",
        downloadHidden: document.querySelector("#settings-update-download")?.hidden ?? null,
        installHidden: document.querySelector("#settings-update-install")?.hidden ?? null,
      };
    })()`);
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
    const image = await window.webContents.capturePage();
    fs.writeFileSync(path.join(output, "screen.png"), image.toPNG());
  } catch (error) {
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ error: error.message }, null, 2));
  }
  app.quit();
});
