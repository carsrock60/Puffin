import assert from "node:assert/strict";
import test from "node:test";
import {
  findSyncedLyricIndex,
  fetchSyncedLyrics,
  parseSyncedLyrics,
  selectSyncedLyricsMatch,
} from "../src/lyrics.js";

test("positive LRC offset advances lyrics by its millisecond value", () => {
  const lines = parseSyncedLyrics("[offset: +5000 ]\n[00:10.00]First line");

  assert.equal(lines[0].time, 5);
});

test("negative LRC offset delays lyrics by its millisecond value", () => {
  const lines = parseSyncedLyrics("[offset:-2500]\n[00:10.00]First line");

  assert.equal(lines[0].time, 12.5);
});

test("a positive offset fixes lyrics that would otherwise start several seconds late", () => {
  const lines = parseSyncedLyrics("[offset:+6000]\n[00:08.00]First line");

  assert.equal(lines[0].time, 2);
  assert.equal(findSyncedLyricIndex(lines, 2), 0);
});

test("lyrics without an offset synchronize at their original timestamps", () => {
  const lines = parseSyncedLyrics("[00:10.00]First line\n[00:12.50]Second line");

  assert.deepEqual(lines.map((line) => line.time), [10, 12.5]);
  assert.equal(findSyncedLyricIndex(lines, 9.99), -1);
  assert.equal(findSyncedLyricIndex(lines, 10), 0);
  assert.equal(findSyncedLyricIndex(lines, 12.5), 1);
});

test("same-title lyrics are selected by the matching recording duration", () => {
  const results = [
    { id: 1, trackName: "Public Song", artistName: "Composer", duration: 244, syncedLyrics: "wrong version" },
    { id: 2, trackName: "Public Song", artistName: "Composer", duration: 184, syncedLyrics: "correct version" },
  ];

  const match = selectSyncedLyricsMatch(results, {
    trackName: "Public Song",
    artistName: "Composer",
    duration: 183.6,
  });

  assert.equal(match.id, 2);
  assert.equal(selectSyncedLyricsMatch([results[0]], {
    trackName: "Public Song",
    artistName: "Composer",
    duration: 183.6,
  }), null);
});

test("a known track duration rejects lyric results without a duration", () => {
  const match = selectSyncedLyricsMatch([
    { trackName: "Public Song", artistName: "Composer", syncedLyrics: "unknown recording" },
  ], {
    trackName: "Public Song",
    artistName: "Composer",
    duration: 184,
  });

  assert.equal(match, null);
});

test("duration matching uses the same whole-second duration sent to LRCLIB", () => {
  const match = selectSyncedLyricsMatch([
    { id: 3, trackName: "Public Song", artistName: "Composer", duration: 203, syncedLyrics: "matching boundary" },
  ], {
    trackName: "Public Song",
    artistName: "Composer",
    duration: 200.99,
  });

  assert.equal(match.id, 3);
});

test("exact lookup rejects a different-duration recording and uses the matching search result", async () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const requestedUrls = [];
  globalThis.window = { setTimeout: globalThis.setTimeout.bind(globalThis) };
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    requestedUrls.push(url);
    const body = url.pathname.endsWith("/get")
      ? { id: 10, trackName: "Public Song", artistName: "Composer", duration: 244, syncedLyrics: "wrong release" }
      : [{ id: 11, trackName: "Public Song", artistName: "Composer", duration: 184, syncedLyrics: "matching release" }];
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => body,
    };
  };

  try {
    const result = await fetchSyncedLyrics({
      trackName: "Public Song",
      artistName: "Composer",
      duration: 183.7,
    });

    assert.equal(result.id, 11);
    assert.equal(requestedUrls[0].searchParams.get("duration"), "184");
    assert.equal(requestedUrls[1].searchParams.has("duration"), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("lyrics lookup requires a measured duration for a safe recording match", async () => {
  await assert.rejects(
    fetchSyncedLyrics({ trackName: "Public Song", artistName: "Composer" }),
    /couldn’t read this track’s duration/i,
  );
});
