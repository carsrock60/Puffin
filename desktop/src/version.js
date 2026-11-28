"use strict";

function numericParts(version) {
  return String(version || "")
    .trim()
    .replace(/^v/i, "")
    .split("-")[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function isNewerVersion(candidate, current) {
  const next = numericParts(candidate);
  const currentParts = numericParts(current);
  const length = Math.max(next.length, currentParts.length);
  for (let index = 0; index < length; index += 1) {
    const left = next[index] || 0;
    const right = currentParts[index] || 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return false;
}

module.exports = { isNewerVersion };
