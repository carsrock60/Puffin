const PREFERENCES_KEY = "puffin.homePreferences";

const DEFAULT_PREFERENCES = {
  showRecentlyPlayed: true,
  showMusicPicks: true,
  musicAtlasApiKey: "",
  acoustidClientKey: "",
};

export function getHomePreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || "{}");
    return {
      showRecentlyPlayed: saved.showRecentlyPlayed !== false,
      showMusicPicks: saved.showMusicPicks !== false,
      musicAtlasApiKey: typeof saved.musicAtlasApiKey === "string" ? saved.musicAtlasApiKey : "",
      acoustidClientKey: typeof saved.acoustidClientKey === "string" ? saved.acoustidClientKey : "",
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function saveHomePreferences(preferences) {
  const next = {
    showRecentlyPlayed: Boolean(preferences.showRecentlyPlayed),
    showMusicPicks: Boolean(preferences.showMusicPicks),
    musicAtlasApiKey: String(preferences.musicAtlasApiKey || "").trim(),
    acoustidClientKey: String(preferences.acoustidClientKey || "").trim(),
  };
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next));
  } catch {
    throw new Error("Puffin couldn’t save Home preferences on this device.");
  }
  window.dispatchEvent(new CustomEvent("puffin:home-preferences-updated", { detail: next }));
  return next;
}
