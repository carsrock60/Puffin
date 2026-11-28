"use strict";

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const output = path.join(__dirname, "..", ".home", "browser-smoke");

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  try {
    await window.loadURL("http://127.0.0.1:5173/");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const result = await window.webContents.executeJavaScript(`(() => {
      const install = document.querySelector("#desktop-install");
      const wifi = document.querySelector("#connection-status");
      const installRect = install?.getBoundingClientRect();
      const wifiRect = wifi?.getBoundingClientRect();
      return {
        bridge: Boolean(window.puffinDesktop),
        installHidden: install?.hidden ?? null,
        installDisplay: install ? getComputedStyle(install).display : null,
        installLabel: install?.getAttribute("aria-label") || "",
        installLeftOfWifi: Boolean(installRect && wifiRect && installRect.right <= wifiRect.left + 1),
        formHidden: document.querySelector("#download-form")?.hidden ?? null,
        requiredHidden: document.querySelector("#download-desktop-required")?.hidden ?? null,
        updateNavHidden: document.querySelector('[data-settings-section="updates"]')?.hidden ?? null,
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
