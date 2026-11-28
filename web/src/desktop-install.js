import {
  PUFFIN_LATEST_RELEASE_API,
  PUFFIN_RELEASES_URL,
  detectMacArchitecture,
  detectPlatform,
  isLaptopDevice,
  pickReleaseAsset,
  releaseAssetUrl,
} from "./install-targets.js";

const RELEASE_CACHE_KEY = "puffin.desktopRelease.v1";
const RELEASE_CACHE_MS = 10 * 60 * 1000;

function laptopNow() {
  return isLaptopDevice({
    width: window.innerWidth,
    finePointer: window.matchMedia("(pointer: fine)").matches,
    maxTouchPoints: navigator.maxTouchPoints || 0,
    platform: navigator.platform || "",
    userAgent: navigator.userAgent || "",
  });
}

function gpuRenderer() {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) return "";
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    return String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || "");
  } catch {
    return "";
  }
}

async function browserArchitecture() {
  try {
    const values = await navigator.userAgentData?.getHighEntropyValues?.(["architecture"]);
    return values?.architecture || "";
  } catch {
    return "";
  }
}

function announce(message) {
  let live = document.querySelector("#desktop-install-feedback");
  if (!live) {
    live = document.createElement("p");
    live.id = "desktop-install-feedback";
    live.className = "visually-hidden";
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");
    document.body.append(live);
  }
  live.textContent = message;
}

function cachedRelease() {
  try {
    const cached = JSON.parse(sessionStorage.getItem(RELEASE_CACHE_KEY) || "null");
    if (!cached || Date.now() - cached.savedAt > RELEASE_CACHE_MS) return null;
    return cached.release;
  } catch {
    return null;
  }
}

async function latestRelease() {
  const cached = cachedRelease();
  if (cached) return cached;
  const response = await fetch(PUFFIN_LATEST_RELEASE_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}.`);
  const payload = await response.json();
  const release = {
    version: String(payload.tag_name || "").replace(/^v/i, ""),
    assets: Array.isArray(payload.assets) ? payload.assets : [],
  };
  try {
    sessionStorage.setItem(RELEASE_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), release }));
  } catch {
    // A private browsing session may not allow the release cache.
  }
  return release;
}

function startBrowserDownload(url) {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  link.target = "_blank";
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
}

function openReleasePage() {
  const opened = window.open(PUFFIN_RELEASES_URL, "_blank");
  if (opened) opened.opener = null;
  else window.location.assign(PUFFIN_RELEASES_URL);
}

async function installForThisComputer(button) {
  if (button.disabled) return;
  const platform = detectPlatform({ platform: navigator.platform || "", userAgent: navigator.userAgent || "" });
  if (platform === "other") {
    announce("Opening the Puffin desktop downloads page.");
    openReleasePage();
    return;
  }

  button.disabled = true;
  const arch = platform === "mac"
    ? detectMacArchitecture({
      userAgentDataArch: await browserArchitecture(),
      gpuRenderer: gpuRenderer(),
    })
    : "x64";
  if (platform === "mac" && !arch) {
    button.disabled = false;
    announce("Opening the Puffin downloads page so you can choose Apple silicon or Intel.");
    openReleasePage();
    return;
  }

  button.classList.add("is-downloading");
  button.setAttribute("aria-busy", "true");
  button.title = "Starting your download…";
  announce("Finding the latest Puffin desktop installer…");

  try {
    const release = await latestRelease();
    const asset = pickReleaseAsset(release.assets, { platform, arch });
    const url = releaseAssetUrl(asset);
    if (!url) throw new Error("No installer is available for this computer yet.");
    startBrowserDownload(url);
    const target = platform === "mac" ? (arch === "arm64" ? "Apple silicon Mac" : "Intel Mac") : "Windows";
    announce(`Downloading Puffin ${release.version ? `${release.version} ` : ""}for ${target}.`);
    button.title = `Downloading Puffin for ${target}…`;
    window.setTimeout(() => {
      button.title = "Download Puffin for desktop";
    }, 4000);
  } catch (error) {
    console.warn("Could not start the desktop installer download:", error);
    announce("Opening the Puffin desktop downloads page.");
    openReleasePage();
  } finally {
    button.disabled = false;
    button.classList.remove("is-downloading");
    button.removeAttribute("aria-busy");
  }
}

export function initializeDesktopInstall() {
  const installButtons = document.querySelectorAll("[data-install-desktop]");
  const hint = document.querySelector("#download-install-hint");
  if (!installButtons.length) return;

  if (window.puffinDesktop?.isDesktop) {
    installButtons.forEach((button) => { button.hidden = true; });
    if (hint) hint.hidden = true;
    return;
  }

  const syncAvailability = () => {
    const available = laptopNow();
    installButtons.forEach((button) => { button.hidden = !available; });
    if (hint) hint.hidden = available;
  };

  installButtons.forEach((button) => {
    button.addEventListener("click", () => installForThisComputer(button));
  });

  syncAvailability();
  window.addEventListener("resize", syncAvailability);
  const pointerQuery = window.matchMedia("(pointer: fine)");
  if (typeof pointerQuery.addEventListener === "function") {
    pointerQuery.addEventListener("change", syncAvailability);
  }
}
