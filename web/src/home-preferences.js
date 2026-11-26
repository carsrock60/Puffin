const PREFERENCES_KEY = "puffin.homePreferences";

const DEFAULT_PREFERENCES = {
  showRecentlyPlayed: true,
  acoustidClientKey: "",
};

function cleanPreferences(saved = {}) {
  return {
    showRecentlyPlayed: saved.showRecentlyPlayed !== false,
    acoustidClientKey: typeof saved.acoustidClientKey === "string" ? saved.acoustidClientKey : "",
  };
}

export function getHomePreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || "{}");
    const preferences = cleanPreferences(saved);
    if (Object.hasOwn(saved, "musicAtlasApiKey") || Object.hasOwn(saved, "showMusicPicks")) {
      try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences)); } catch { /* Remove the legacy key when storage allows. */ }
    }
    return preferences;
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function saveHomePreferences(preferences) {
  const next = cleanPreferences(preferences);
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next));
  } catch {
    throw new Error("Puffin couldn’t save Home preferences on this device.");
  }
  window.dispatchEvent(new CustomEvent("puffin:home-preferences-updated", { detail: next }));
  return next;
}
