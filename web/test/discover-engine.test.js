import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDiscoveryProfile,
  discoveryProfileSignature,
  discoverySeedContext,
  isDiscoveryCacheFresh,
  isDiscoveryCacheUsable,
  mergeSeenArtists,
  normalizeDiscoveryName,
} from "../src/discover-engine.js";

function audio(id, artist, title, extra = {}) {
  return { id, kind: "audio", artist, title, ...extra };
}

test("discovery profile keeps only the compact listening signals the backend needs", () => {
  const records = [
    audio("a1", "Aurora", "Runaway", { importedAt: 100 }),
    audio("a2", "Aurora", "The River", { importedAt: 200 }),
    audio("b1", "Björk", "Jóga"),
    audio("v1", "Aurora", "Live video", { kind: "video" }),
    audio("blank", "", "Untitled"),
  ];
  const stats = { days: {
    "2026-01-01": { trackPlays: { a1: 4, a2: 2, b1: 1 } },
    "2026-01-02": { trackPlays: { a1: 3, blank: 99 } },
  } };
  const profile = buildDiscoveryProfile(records, stats, [records[2], records[0]], 1000);

  assert.equal(profile.hasLibrary, true);
  assert.equal(profile.hasListeningHistory, true);
  assert.equal(profile.trackCount, 4);
  assert.equal(profile.artistCount, 2);
  assert.equal(profile.seeds.length, 2);
  assert.deepEqual(profile.seeds.find((seed) => seed.name === "Aurora"), {
    name: "Aurora",
    playCount: 9,
    libraryCount: 2,
    recentRank: 1,
    sampleTracks: ["Runaway", "The River"],
  });
  assert.equal(profile.seeds.some((seed) => seed.name === "Aurora" && "id" in seed), false);
  assert.match(profile.signature, /^[a-z0-9]+$/);
});

test("known artists are library artists outside the seed set and require two tracks", () => {
  const records = [];
  for (let index = 0; index < 10; index += 1) {
    const name = `Artist ${index}`;
    records.push(audio(`track-${index}-1`, name, "One"), audio(`track-${index}-2`, name, "Two"));
  }
  const stats = { days: { "2026-01-01": { trackPlays: Object.fromEntries(records.map((record, index) => [record.id, index])) } } };
  const profile = buildDiscoveryProfile(records, stats, [], 1000);

  assert.equal(profile.seeds.length, 8);
  assert.ok(profile.knownArtists.length > 0);
  const seedNames = new Set(profile.seeds.map((seed) => seed.name));
  assert.equal(profile.knownArtists.some((name) => seedNames.has(name)), false);
});

test("an empty library produces a clear cold-start profile", () => {
  const profile = buildDiscoveryProfile([], {}, []);

  assert.deepEqual(profile.seeds, []);
  assert.deepEqual(profile.knownArtists, []);
  assert.equal(profile.hasLibrary, false);
  assert.equal(profile.hasListeningHistory, false);
  assert.equal(discoverySeedContext(profile), "");
});

test("name normalization is stable across punctuation, accents, and case", () => {
  assert.equal(normalizeDiscoveryName("  Björk & The—Extras "), "bjork and the extras");
  assert.equal(normalizeDiscoveryName("AC/DC"), "ac dc");
});

test("cache freshness requires a matching profile, recommendations, and a recent save", () => {
  const profile = { signature: "abc", seeds: [{ name: "Aurora" }] };
  const cache = { savedAt: 1000, profileSignature: "abc", payload: { recommendations: [{ name: "Nils Frahm" }] } };

  assert.equal(isDiscoveryCacheFresh(cache, profile, 2000), true);
  assert.equal(isDiscoveryCacheFresh(cache, profile, 1000 + 31 * 60 * 1000), false);
  assert.equal(isDiscoveryCacheFresh(cache, { signature: "different" }, 2000), false);
  assert.equal(isDiscoveryCacheFresh({ ...cache, savedAt: 5000 }, profile, 2000), false);
  assert.equal(isDiscoveryCacheFresh({ ...cache, payload: { recommendations: [] } }, profile, 2000), false);
});

test("a saved mix remains usable while a fresh profile loads", () => {
  assert.equal(isDiscoveryCacheUsable({ payload: { recommendations: [{ name: "Nils Frahm" }] } }), true);
  assert.equal(isDiscoveryCacheUsable({ payload: { recommendations: [] } }), false);
  assert.equal(isDiscoveryCacheUsable(null), false);
});

test("seen artists are deduplicated, recent recommendations come first, and the list is capped", () => {
  const seen = mergeSeenArtists(["Aurora", "Nils Frahm"], [{ name: "nils frahm" }, { name: "Hania Rani" }, { name: "" }], 3);

  assert.deepEqual(seen, ["nils frahm", "Hania Rani", "Aurora"]);
  assert.equal(mergeSeenArtists([], [{ name: "A" }, { name: "B" }, { name: "C" }], 2).length, 2);
});

test("seed context names the inspirations without exposing the full profile", () => {
  assert.equal(discoverySeedContext({ seeds: [{ name: "Aurora" }] }), "Inspired by Aurora");
  assert.equal(discoverySeedContext({ seeds: [{ name: "Aurora" }, { name: "Björk" }] }), "Inspired by Aurora and Björk");
  assert.equal(discoverySeedContext({ seeds: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }] }), "Inspired by A, B, C and more");
});

test("profile signatures change when the listening profile changes", () => {
  const base = { seeds: [{ name: "Aurora", playCount: 1, libraryCount: 1, sampleTracks: ["Runaway"] }], knownArtists: ["Björk"], hasListeningHistory: true };
  const first = discoveryProfileSignature(base);
  const second = discoveryProfileSignature({ ...base, seeds: [{ ...base.seeds[0], playCount: 2 }] });

  assert.notEqual(first, second);
  assert.equal(first, discoveryProfileSignature({ ...base }));
});
