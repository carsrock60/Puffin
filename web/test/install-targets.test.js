import test from "node:test";
import assert from "node:assert/strict";
import {
  detectMacArchitecture,
  detectPlatform,
  isLaptopDevice,
  pickReleaseAsset,
  releaseAssetUrl,
} from "../src/install-targets.js";

test("the desktop download button appears on laptops but not phones or tablets", () => {
  assert.equal(isLaptopDevice({ width: 1440, finePointer: true }), true);
  assert.equal(isLaptopDevice({ width: 1440, finePointer: true, platform: "MacIntel", maxTouchPoints: 5, userAgent: "Macintosh" }), false);
  assert.equal(isLaptopDevice({ width: 390, finePointer: true }), false);
  assert.equal(isLaptopDevice({ width: 1440, finePointer: false }), false);
  assert.equal(isLaptopDevice({ width: 1024, finePointer: true, userAgent: "iPad" }), false);
  assert.equal(isLaptopDevice({ width: 1280, finePointer: true, userAgent: "Mozilla/5.0 (Linux; Android 13; SM-X700)" }), false);
});

test("the installer platform is detected from the browser", () => {
  assert.equal(detectPlatform({ platform: "MacIntel", userAgent: "Macintosh" }), "mac");
  assert.equal(detectPlatform({ platform: "Win32", userAgent: "Windows NT 10.0" }), "windows");
  assert.equal(detectPlatform({ platform: "Linux x86_64", userAgent: "Linux" }), "other");
});

test("Apple silicon and Intel Macs receive different installers", () => {
  assert.equal(detectMacArchitecture({ userAgentDataArch: "arm" }), "arm64");
  assert.equal(detectMacArchitecture({ userAgentDataArch: "x86" }), "x64");
  assert.equal(detectMacArchitecture({ gpuRenderer: "Apple M2" }), "arm64");
  assert.equal(detectMacArchitecture({ gpuRenderer: "Intel Iris Plus Graphics" }), "x64");
  assert.equal(detectMacArchitecture({ gpuRenderer: "WebKit WebGL" }), "");
});

test("release assets are matched by platform and architecture", () => {
  const assets = [
    { name: "Puffin-1.0.0-arm64.dmg", browser_download_url: "https://example.com/arm.dmg" },
    { name: "Puffin-1.0.0-x64.dmg", browser_download_url: "https://example.com/intel.dmg" },
    { name: "Puffin-1.0.0-arm64.zip", browser_download_url: "https://example.com/arm.zip" },
    { name: "Puffin-Setup-1.0.0-x64.exe", browser_download_url: "https://example.com/setup.exe" },
    { name: "latest-mac.yml", browser_download_url: "https://example.com/latest.yml" },
  ];

  assert.equal(pickReleaseAsset(assets, { platform: "mac", arch: "arm64" }).name, "Puffin-1.0.0-arm64.dmg");
  assert.equal(pickReleaseAsset(assets, { platform: "mac", arch: "" }), null);
  assert.equal(pickReleaseAsset(assets, { platform: "mac", arch: "x64" }).name, "Puffin-1.0.0-x64.dmg");
  assert.equal(pickReleaseAsset(assets, { platform: "windows", arch: "x64" }).name, "Puffin-Setup-1.0.0-x64.exe");
  assert.equal(pickReleaseAsset([{ name: "Puffin-1.0.0-arm64.zip", browser_download_url: "https://example.com/arm.zip" }], { platform: "mac", arch: "arm64" }).name, "Puffin-1.0.0-arm64.zip");
  assert.equal(pickReleaseAsset(assets, { platform: "other", arch: "x64" }), null);
  assert.equal(releaseAssetUrl(assets[0]), "https://example.com/arm.dmg");
});
