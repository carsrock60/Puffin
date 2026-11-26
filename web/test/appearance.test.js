import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../public/appearance.js", import.meta.url), "utf8");

function setup(saved = null) {
  const store = new Map(saved ? [["puffin.appearance.v1", JSON.stringify(saved)]] : []);
  const media = {};
  const inputs = [
    ...["light", "dark", "system"].map((value) => control({ name: "theme", value })),
    ...["blue", "violet", "emerald", "rose", "amber"].map((value) => control({ name: "accent", value })),
    ...["comfortable", "compact"].map((value) => control({ name: "density", value })),
  ];
  function control(properties = {}) {
    return { ...properties, checked: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute(name, value) { this[name] = value; }, fire(type) { this.listeners[type]({ target: this }); } };
  }
  const elements = { "#appearance-reduce-motion": control(), "#appearance-motion-hint": {}, "#theme-toggle": control(), "#appearance-status": {}, "#appearance-reset": control() };
  const root = { dataset: {}, classList: { values: new Set(), toggle(name, enabled) { enabled ? this.values.add(name) : this.values.delete(name); }, contains(name) { return this.values.has(name); } } };
  const document = { documentElement: root, querySelectorAll: () => inputs, querySelector: (selector) => elements[selector], addEventListener(type, fn) { if (type === "DOMContentLoaded") this.ready = fn; } };
  const window = { matchMedia(query) { return media[query] ||= { matches: false, addEventListener(type, fn) { this.change = fn; } }; }, addEventListener() {} };
  const localStorage = { getItem: (key) => store.get(key) || null, setItem: (key, value) => store.set(key, value) };
  runInNewContext(source, { window, document, localStorage, JSON });
  document.ready();
  return { inputs, elements, root, media, store };
}

test("appearance applies persisted choices and quick toggle updates the theme", () => {
  const app = setup({ theme: "dark", accent: "rose", density: "compact", reduceMotion: true });
  assert.equal(app.root.classList.contains("dark"), true);
  assert.equal(app.root.dataset.accent, "rose");
  assert.equal(app.root.dataset.density, "compact");
  assert.equal(app.root.dataset.reduceMotion, "true");
  app.elements["#theme-toggle"].fire("click");
  assert.equal(JSON.parse(app.store.get("puffin.appearance.v1")).theme, "light");
  assert.equal(app.root.classList.contains("dark"), false);
});

test("system theme and reduced motion track operating system changes and reset is scoped", () => {
  const app = setup();
  const scheme = app.media["(prefers-color-scheme: dark)"];
  const motion = app.media["(prefers-reduced-motion: reduce)"];
  scheme.matches = true; scheme.change();
  assert.equal(app.root.classList.contains("dark"), true);
  motion.matches = true; motion.change();
  assert.equal(app.root.dataset.reduceMotion, "true");
  assert.equal(app.elements["#appearance-reduce-motion"].disabled, true);
  motion.matches = false; motion.change();
  const violet = app.inputs.find((input) => input.value === "violet");
  violet.checked = true; violet.fire("change");
  app.store.set("unrelated", "keep");
  app.elements["#appearance-reset"].fire("click");
  assert.equal(app.root.dataset.accent, "blue");
  assert.equal(app.store.get("unrelated"), "keep");
  assert.equal(JSON.parse(app.store.get("puffin.appearance.v1")).theme, "system");
});
