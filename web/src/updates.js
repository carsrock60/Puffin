const STATE_LABELS = {
  idle: "Ready to check for updates",
  checking: "Checking for updates…",
  available: "An update is available",
  downloading: "Downloading an update",
  downloaded: "An update is ready to install",
  current: "Puffin is up to date",
  "not-available": "Puffin is up to date",
  error: "Could not check for updates",
  unsupported: "Updates are available in the installed app",
};

function statusVersion(status) {
  const version = status?.availableVersion || status?.version;
  return version ? `Version ${version}` : "";
}

export function initializeUpdates() {
  const bridge = window.puffinDesktop?.updates;
  const desktopOnly = document.querySelectorAll("[data-desktop-only]");
  if (!bridge) {
    desktopOnly.forEach((element) => { element.hidden = true; });
    return;
  }

  desktopOnly.forEach((element) => {
    // Settings sections stay hidden until the user selects them; settings.js
    // owns that visibility. Everything else is safe to reveal now.
    if (!element.hasAttribute("data-settings-panel")) element.hidden = false;
  });

  const dot = document.querySelector("#settings-update-dot");
  const settingsButton = document.querySelector("#settings-open");
  const current = document.querySelector("#settings-update-current");
  const stateLabel = document.querySelector("#settings-update-state");
  const statusLine = document.querySelector("#settings-update-status");
  const progress = document.querySelector("#settings-update-progress");
  const checkButton = document.querySelector("#settings-update-check");
  const downloadButton = document.querySelector("#settings-update-download");
  const installButton = document.querySelector("#settings-update-install");
  const autoCheck = document.querySelector("#settings-update-auto");
  const releaseLink = document.querySelector("#settings-update-release");
  let latestStatus = { state: "idle", autoCheck: true, manual: false };

  function render(status = latestStatus) {
    latestStatus = { ...latestStatus, ...status };
    const state = latestStatus.state || "idle";
    const available = ["available", "downloading", "downloaded"].includes(state);
    const ready = state === "downloaded";
    const busy = ["checking", "downloading"].includes(state);

    if (dot) dot.hidden = !available;
    if (settingsButton) {
      const label = available ? "Settings, update available" : "Settings";
      settingsButton.setAttribute("aria-label", label);
      settingsButton.title = label;
    }

    if (current) current.textContent = latestStatus.currentVersion || "";
    if (stateLabel) {
      const version = statusVersion(latestStatus);
      stateLabel.textContent = state === "available" && version
        ? `${version} is available`
        : state === "downloading" && version
          ? `Downloading ${version}`
          : state === "downloaded" && version
            ? `${version} is ready to install`
            : STATE_LABELS[state] || STATE_LABELS.idle;
    }

    if (statusLine) {
      statusLine.textContent = latestStatus.message || (
        state === "not-available" ? "You have the latest version." : ""
      );
    }

    if (progress) {
      progress.hidden = state !== "downloading";
      progress.value = Math.max(0, Math.min(100, Number(latestStatus.progress ?? latestStatus.percent) || 0));
    }
    if (checkButton) checkButton.disabled = busy || state === "unsupported";
    if (downloadButton) {
      downloadButton.hidden = state !== "available";
      downloadButton.textContent = latestStatus.manual ? "Open download page" : "Download update";
    }
    if (installButton) installButton.hidden = !ready;
    if (autoCheck && typeof latestStatus.autoCheck === "boolean") autoCheck.checked = latestStatus.autoCheck;
    if (releaseLink) {
      releaseLink.hidden = !latestStatus.releaseUrl;
      if (latestStatus.releaseUrl) releaseLink.href = latestStatus.releaseUrl;
    }
  }

  checkButton?.addEventListener("click", async () => {
    checkButton.disabled = true;
    try {
      render(await bridge.check());
    } catch (error) {
      render({ state: "error", message: error?.message || "Puffin could not check for updates." });
    } finally {
      checkButton.disabled = false;
    }
  });

  downloadButton?.addEventListener("click", async () => {
    if (latestStatus.manual) {
      const url = latestStatus.releaseUrl;
      if (url) {
        try {
          await window.puffinDesktop?.openExternal?.(url);
        } catch (error) {
          render({ state: latestStatus.state, message: error?.message || "Puffin could not open the release page." });
        }
      }
      return;
    }
    downloadButton.disabled = true;
    try {
      render(await bridge.download());
    } catch (error) {
      render({ state: "error", message: error?.message || "Puffin could not download the update." });
    } finally {
      downloadButton.disabled = false;
    }
  });

  installButton?.addEventListener("click", async () => {
    installButton.disabled = true;
    try {
      await bridge.install();
    } catch (error) {
      installButton.disabled = false;
      render({ state: "error", message: error?.message || "Puffin could not install the update." });
    }
  });

  autoCheck?.addEventListener("change", async () => {
    try {
      render(await bridge.setAutoCheck(autoCheck.checked));
    } catch (error) {
      render({ state: latestStatus.state, message: error?.message || "Puffin could not save this preference." });
    }
  });

  bridge.onStatus(render);
  bridge.getState().then((status) => {
    if (status) render(status);
  }).catch((error) => {
    render({ state: "error", message: error?.message || "Update information is unavailable." });
  });
}
