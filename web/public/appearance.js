(() => {
  const key = "puffin.appearance.v1";
  const defaults = { theme: "system", accent: "blue", density: "comfortable", reduceMotion: false };
  const options = { theme: ["light", "dark", "system"], accent: ["blue", "violet", "emerald", "rose", "amber"], density: ["comfortable", "compact"] };
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch { /* Use defaults if storage is unavailable. */ }
  let preferences = {
    theme: options.theme.includes(saved.theme) ? saved.theme : defaults.theme,
    accent: options.accent.includes(saved.accent) ? saved.accent : defaults.accent,
    density: options.density.includes(saved.density) ? saved.density : defaults.density,
    reduceMotion: saved.reduceMotion === true,
  };

  function apply() {
    const dark = preferences.theme === "dark" || (preferences.theme === "system" && scheme.matches);
    const reduced = preferences.reduceMotion || motion.matches;
    const root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.dataset.accent = preferences.accent;
    root.dataset.density = preferences.density;
    root.dataset.reduceMotion = String(reduced);
    document.querySelectorAll("[data-appearance-option]").forEach((input) => {
      input.checked = preferences[input.name] === input.value;
    });
    const motionInput = document.querySelector("#appearance-reduce-motion");
    if (motionInput) {
      motionInput.checked = reduced;
      motionInput.disabled = motion.matches;
    }
    const motionHint = document.querySelector("#appearance-motion-hint");
    if (motionHint) motionHint.textContent = motion.matches ? "Reduced motion is enabled by your device." : "Reduce nonessential animation.";
    const toggle = document.querySelector("#theme-toggle");
    if (toggle) {
      toggle.setAttribute("aria-pressed", String(dark));
      toggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
      toggle.title = dark ? "Switch to light mode" : "Switch to dark mode";
    }
  }

  function update(changes) {
    preferences = { ...preferences, ...changes };
    let savedSuccessfully = true;
    try { localStorage.setItem(key, JSON.stringify(preferences)); } catch { savedSuccessfully = false; }
    apply();
    const status = document.querySelector("#appearance-status");
    if (status) status.textContent = savedSuccessfully ? "" : "Appearance could not be saved on this device.";
  }

  scheme.addEventListener("change", apply);
  motion.addEventListener("change", apply);
  window.addEventListener("storage", (event) => {
    if (event.key !== key) return;
    try {
      const next = event.newValue ? JSON.parse(event.newValue) : {};
      preferences = {
        theme: options.theme.includes(next.theme) ? next.theme : defaults.theme,
        accent: options.accent.includes(next.accent) ? next.accent : defaults.accent,
        density: options.density.includes(next.density) ? next.density : defaults.density,
        reduceMotion: next.reduceMotion === true,
      };
      apply();
    } catch { /* Ignore invalid external values. */ }
  });
  apply();
  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-appearance-option]").forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked && options[input.name]?.includes(input.value)) update({ [input.name]: input.value });
      });
    });
    document.querySelector("#appearance-reduce-motion").addEventListener("change", (event) => update({ reduceMotion: event.target.checked }));
    document.querySelector("#appearance-reset").addEventListener("click", () => update(defaults));
    document.querySelector("#theme-toggle").addEventListener("click", () => update({ theme: document.documentElement.classList.contains("dark") ? "light" : "dark" }));
    apply();
  });
})();
