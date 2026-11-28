"use strict";

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const ffmpegPath = require("ffmpeg-static");

const home = path.join(__dirname, "..", ".home");
fs.mkdirSync(home, { recursive: true });
const mediaPath = path.join(home, "smoke-media.mp4");
if (!fs.existsSync(mediaPath)) {
  execFileSync(ffmpegPath, [
    "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "mpeg4", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    "-movflags", "+faststart", mediaPath,
  ], { stdio: "ignore" });
}

const resultPath = path.join(home, "smoke-result.json");
const logs = [];

const { downloads } = require("../src/main");
downloads.jobs.set("smoke-media", {
  id: "smoke-media",
  status: "ready",
  filePath: mediaPath,
  filename: "Smoke Test.mp4",
  mime: "video/mp4",
  kind: "video",
  size: fs.statSync(mediaPath).size,
});

app.on("browser-window-created", (_event, window) => {
  window.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) logs.push(message);
  });
  window.webContents.on("render-process-gone", (_e, details) => {
    fs.writeFileSync(resultPath, JSON.stringify({ ok: false, reason: "renderer gone", details, logs }, null, 2));
    app.quit();
  });
  window.webContents.once("did-finish-load", async () => {
    try {
      const result = await window.webContents.executeJavaScript(`(async () => {
        const install = document.querySelector("#desktop-install");
        const form = document.querySelector("#download-form");
        const required = document.querySelector("#download-desktop-required");
        const updateNav = document.querySelector('[data-settings-section="updates"]');
        const updateDot = document.querySelector("#settings-update-dot");
        const gear = document.querySelector("#settings-open svg");
        const storageProbe = await Promise.race([
          navigator.storage?.estimate?.().then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error: error.message })) || Promise.resolve({ ok: false, error: "no storage manager" }),
          new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "timeout" }), 3000)),
        ]);
        const indexedDbProbe = await Promise.race([
          new Promise((resolve) => {
            const request = indexedDB.open("puffin-smoke-probe", 1);
            request.onsuccess = () => { request.result.close(); indexedDB.deleteDatabase("puffin-smoke-probe"); resolve({ ok: true }); };
            request.onerror = () => resolve({ ok: false, error: request.error?.message || "request failed" });
            request.onblocked = () => resolve({ ok: false, error: "blocked" });
          }),
          new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "timeout" }), 3000)),
        ]);
        const response = await fetch("puffin-media://download/smoke-media");
        const buffer = await response.arrayBuffer();
        return {
          title: document.title,
          bridge: Boolean(window.puffinDesktop?.downloads && window.puffinDesktop?.updates),
          installHidden: install ? install.hidden : null,
          formHidden: form ? form.hidden : null,
          requiredHidden: required ? required.hidden : null,
          updateNavHidden: updateNav ? updateNav.hidden : null,
          updateDotHidden: updateDot ? updateDot.hidden : null,
          gearCircles: gear ? gear.querySelectorAll("circle").length : null,
          settingsButtonIcon: gear?.outerHTML || "",
          webSettingsHidden: document.querySelector("#settings-download-web")?.hidden ?? null,
          desktopSettingsHidden: document.querySelector("#settings-download-desktop")?.hidden ?? null,
          folderButtonPresent: Boolean(document.querySelector("#settings-open-downloads-folder")),
          storageProbe,
          indexedDbProbe,
          media: {
            ok: response.ok,
            status: response.status,
            type: response.headers.get("content-type"),
            bytes: buffer.byteLength,
            disposition: response.headers.get("content-disposition"),
          },
          bodyText: document.body.innerText.slice(0, 120),
        };
      })()`);
      if (process.env.SMOKE_SETTINGS === "1") {
        result.settings = await window.webContents.executeJavaScript(`(async () => {
          document.querySelector("#settings-open")?.click();
          await new Promise((resolve) => setTimeout(resolve, 250));
          document.querySelector('[data-settings-section="updates"]')?.click();
          await new Promise((resolve) => setTimeout(resolve, 250));
          return {
            dialogOpen: Boolean(document.querySelector("#settings-dialog")?.open),
            updatePanelHidden: document.querySelector('[data-settings-panel="updates"]')?.hidden ?? null,
            filesPanelHidden: document.querySelector('[data-settings-panel="files"]')?.hidden ?? null,
            activeSection: document.querySelector('[data-settings-section][aria-current="page"]')?.dataset.settingsSection || "",
            updatesTop: document.querySelector('[data-settings-panel="updates"]')?.getBoundingClientRect().top ?? null,
            filesTop: document.querySelector('[data-settings-panel="files"]')?.getBoundingClientRect().top ?? null,
            updateState: document.querySelector("#settings-update-state")?.textContent || "",
            updateStatus: document.querySelector("#settings-update-status")?.textContent || "",
            updateDotHidden: document.querySelector("#settings-update-dot")?.hidden ?? null,
          };
        })()`);
        await new Promise((resolve) => setTimeout(resolve, 700));
        result.afterSettingsWait = await window.webContents.executeJavaScript(`({
          dialogOpen: Boolean(document.querySelector("#settings-dialog")?.open),
          activeSection: document.querySelector('[data-settings-section][aria-current="page"]')?.dataset.settingsSection || "",
          updatePanelHidden: document.querySelector('[data-settings-panel="updates"]')?.hidden ?? null,
        })`);
      }
      const image = await window.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, "..", ".home", process.env.SMOKE_SETTINGS === "1" ? "settings-smoke.png" : "smoke.png"), image.toPNG());
      fs.writeFileSync(resultPath, JSON.stringify({ ok: true, result, logs }, null, 2));
    } catch (error) {
      fs.writeFileSync(resultPath, JSON.stringify({ ok: false, reason: error.message, logs }, null, 2));
    }
    setTimeout(() => app.quit(), 300);
  });
});

setTimeout(() => {
  fs.writeFileSync(resultPath, JSON.stringify({ ok: false, reason: "timeout", logs }, null, 2));
  app.quit();
}, 20000);
