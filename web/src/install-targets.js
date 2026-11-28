export const PUFFIN_RELEASES_URL = "https://github.com/carsrock60/Puffin/releases";
export const PUFFIN_LATEST_RELEASE_API = "https://api.github.com/repos/carsrock60/Puffin/releases/latest";

export function isLaptopDevice({
  width = 0,
  finePointer = false,
  maxTouchPoints = 0,
  platform = "",
  userAgent = "",
} = {}) {
  const ipad = /iPad/i.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
  const tablet = /Tablet|PlayBook|Silk/i.test(userAgent) || (/Android/i.test(userAgent) && !/Mobile/i.test(userAgent));
  const phone = /iPhone|iPod|Android.*Mobile|Windows Phone/i.test(userAgent);
  return Boolean(finePointer) && width >= 900 && !ipad && !tablet && !phone;
}

export function detectPlatform({ platform = "", userAgent = "" } = {}) {
  if (/Win/i.test(platform) || /Windows/i.test(userAgent)) return "windows";
  if (/Mac/i.test(platform) || /Mac OS X/i.test(userAgent)) return "mac";
  return "other";
}

export function detectMacArchitecture({ userAgentDataArch = "", gpuRenderer = "" } = {}) {
  if (userAgentDataArch === "arm") return "arm64";
  if (userAgentDataArch === "x86") return "x64";
  if (/Apple\s*M\d|Apple GPU/i.test(gpuRenderer)) return "arm64";
  if (/Intel|AMD|Radeon|NVIDIA/i.test(gpuRenderer)) return "x64";
  // Safari and privacy-hardened browsers can hide both signals. Do not guess
  // the architecture: the caller sends an unknown Mac to the release page so
  // Intel and Apple silicon users can choose the correct installer.
  return "";
}

function assetName(asset) {
  return String(asset?.name || "");
}

export function pickReleaseAsset(assets = [], { platform = "", arch = "x64" } = {}) {
  const byName = (pattern) => assets.find((asset) => pattern.test(assetName(asset)));
  if (platform === "mac") {
    if (arch !== "x64" && arch !== "arm64") return null;
    if (arch === "x64") {
      return byName(/-x64\.dmg$/i) || byName(/-intel\.dmg$/i) || byName(/-universal\.dmg$/i)
        || byName(/-x64\.zip$/i) || byName(/-intel\.zip$/i) || byName(/-universal\.zip$/i);
    }
    return byName(/-arm64\.dmg$/i) || byName(/-apple-silicon\.dmg$/i) || byName(/-universal\.dmg$/i)
      || byName(/-arm64\.zip$/i) || byName(/-apple-silicon\.zip$/i) || byName(/-universal\.zip$/i);
  }
  if (platform === "windows") {
    return byName(/-x64\.exe$/i) || byName(/Setup.*\.exe$/i) || byName(/\.exe$/i);
  }
  return null;
}

export function releaseAssetUrl(asset) {
  return typeof asset?.browser_download_url === "string" ? asset.browser_download_url : "";
}
