const KEY = "puffin.downloadPreferences";

const DEFAULTS = { piAddress: "" };

export function getDownloadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    return {
      piAddress: typeof saved.piAddress === "string"
        ? saved.piAddress
        : (localStorage.getItem("puffin-pi-address") || ""),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveDownloadPreferences(preferences) {
  const next = {
    piAddress: String(preferences.piAddress || "").trim(),
  };
  localStorage.setItem(KEY, JSON.stringify(next));
  localStorage.removeItem("puffin-pi-address");
  window.dispatchEvent(new CustomEvent("puffin:download-preferences-updated", { detail: next }));
  return next;
}
