"use strict";

const { app, net } = require("electron");
const { autoUpdater } = require("electron-updater");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { isNewerVersion } = require("./version");

const RELEASES_URL = "https://github.com/carsrock60/Puffin/releases/latest";
const RELEASE_API = "https://api.github.com/repos/carsrock60/Puffin/releases/latest";
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

function friendlyUpdateError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  if (/ENOTFOUND|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|net::ERR/i.test(message)) {
    return "Puffin could not reach the update service. It will try again later.";
  }
  if (/404|CHANNEL_FILE_NOT_FOUND|latest.*not found/i.test(message) || code.includes("404")) {
    return "No published update is available yet.";
  }
  if (/signature|code signature|not signed|CSC/i.test(message)) {
    return "This build cannot update itself automatically. Download the latest installer from GitHub.";
  }
  return "Puffin could not check for updates right now. You can try again from Settings.";
}

class UpdateManager extends EventEmitter {
  constructor() {
    super();
    this.supported = app.isPackaged;
    this.preferencesPath = path.join(app.getPath("userData"), "update-preferences.json");
    this.autoCheck = true;
    this.timer = null;
    this.interval = null;
    this.checking = false;
    this.state = {
      supported: this.supported,
      state: this.supported ? "idle" : "unsupported",
      currentVersion: app.getVersion(),
      availableVersion: "",
      progress: 0,
      manual: false,
      message: this.supported ? "" : "Updates are available in the installed Puffin app.",
      autoCheck: true,
      releaseUrl: RELEASES_URL,
    };
  }

  initialize() {
    this.autoCheck = this._loadAutoCheck();
    this.state.autoCheck = this.autoCheck;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;

    autoUpdater.on("checking-for-update", () => this._setState({ state: "checking", message: "Checking for updates…" }));
    autoUpdater.on("update-available", (info) => {
      this._setState({
        state: "available",
        availableVersion: String(info?.version || ""),
        progress: 0,
        manual: false,
        message: "A new version of Puffin is ready to download.",
      });
    });
    autoUpdater.on("update-not-available", () => {
      this._setState({ state: "current", availableVersion: "", progress: 0, manual: false, message: "Puffin is up to date." });
    });
    autoUpdater.on("download-progress", (progress) => {
      this._setState({
        state: "downloading",
        progress: Math.max(0, Math.min(100, Number(progress?.percent) || 0)),
        message: "Downloading the update in the background…",
      });
    });
    autoUpdater.on("update-downloaded", (info) => {
      this._setState({
        state: "downloaded",
        availableVersion: String(info?.version || this.state.availableVersion || ""),
        progress: 100,
        message: "The update is ready. Restart Puffin to finish.",
      });
    });
    autoUpdater.on("error", (error) => {
      // A rejected check is handled by check(), which can fall back to the
      // public release page. Errors during a download still surface here.
      if (this.checking) return;
      this._setState({ state: "error", message: friendlyUpdateError(error) });
    });

    if (this.supported && this.autoCheck) {
      this.timer = setTimeout(() => this.check({ quiet: true }), 15000);
      this.timer.unref?.();
      this.interval = setInterval(() => this.check({ quiet: true }), CHECK_INTERVAL);
      this.interval.unref?.();
    }
    return this.getState();
  }

  _loadAutoCheck() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.preferencesPath, "utf8"));
      return parsed.autoCheck !== false;
    } catch {
      return true;
    }
  }

  _saveAutoCheck() {
    try {
      fs.mkdirSync(path.dirname(this.preferencesPath), { recursive: true });
      fs.writeFileSync(this.preferencesPath, JSON.stringify({ autoCheck: this.autoCheck }, null, 2));
    } catch {
      // The preference still applies for this session.
    }
  }

  _setState(patch) {
    this.state = { ...this.state, ...patch, autoCheck: this.autoCheck, currentVersion: app.getVersion() };
    this.emit("status", this.getState());
    return this.getState();
  }

  getState() {
    return { ...this.state, autoCheck: this.autoCheck, currentVersion: app.getVersion() };
  }

  async check({ quiet = false } = {}) {
    if (!this.supported) {
      if (!quiet) {
        this._setState({ state: "unsupported", message: "Automatic updates are available in the installed Puffin app." });
      }
      return this.getState();
    }
    if (this.state.state === "checking" || this.state.state === "downloading") return this.getState();
    this.checking = true;
    this._setState({ state: "checking", message: quiet ? "" : "Checking for updates…" });
    try {
      await autoUpdater.checkForUpdates();
      if (this.state.state === "checking") {
        try {
          return await this._checkReleasePage();
        } catch (error) {
          this._setState({ state: "error", message: friendlyUpdateError(error) });
        }
      }
    } catch (error) {
      try {
        return await this._checkReleasePage();
      } catch {
        this._setState({ state: "error", message: friendlyUpdateError(error) });
      }
    } finally {
      this.checking = false;
    }
    return this.getState();
  }

  async _checkReleasePage() {
    const response = await net.fetch(RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `Puffin/${app.getVersion()}`,
      },
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}.`);
    const release = await response.json();
    const version = String(release?.tag_name || "").replace(/^v/i, "");
    if (!version) throw new Error("The latest release has no version.");
    const releaseUrl = String(release?.html_url || RELEASES_URL);
    if (isNewerVersion(version, app.getVersion())) {
      this._setState({
        state: "available",
        availableVersion: version,
        progress: 0,
        manual: true,
        releaseUrl,
        message: `Puffin ${version} is available. Download the new installer from GitHub.`,
      });
    } else {
      this._setState({
        state: "current",
        availableVersion: "",
        progress: 0,
        manual: false,
        releaseUrl,
        message: "Puffin is up to date.",
      });
    }
    return this.getState();
  }

  async download() {
    if (!this.supported) return this.getState();
    if (this.state.state !== "available" || this.state.manual) return this.getState();
    this._setState({ state: "downloading", progress: 0, message: "Downloading the update in the background…" });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this._setState({ state: "error", message: friendlyUpdateError(error) });
    }
    return this.getState();
  }

  install() {
    if (this.state.state !== "downloaded") return false;
    setImmediate(() => {
      try {
        autoUpdater.quitAndInstall(false, true);
      } catch {
        // The user can still restart Puffin manually.
      }
    });
    return true;
  }

  setAutoCheck(enabled) {
    this.autoCheck = Boolean(enabled);
    this.state.autoCheck = this.autoCheck;
    this._saveAutoCheck();
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    if (this.supported && this.autoCheck) {
      this.interval = setInterval(() => this.check({ quiet: true }), CHECK_INTERVAL);
      this.interval.unref?.();
      this.check({ quiet: true });
    }
    this.emit("status", this.getState());
    return this.getState();
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
  }
}

module.exports = { RELEASES_URL, UpdateManager };
