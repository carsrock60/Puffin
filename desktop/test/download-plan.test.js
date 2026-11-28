"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildDownloadArgs,
  buildSearchArgs,
  cleanQuery,
  mediaMimeFor,
  parseProgressLine,
  parseSearchPayload,
  pickSubtitleFile,
  selectMediaFile,
  subtitleLanguageFromFile,
} = require("../src/download-plan");

test("search arguments are scoped to twelve flat YouTube results", () => {
  const args = buildSearchArgs("  Apollo   11  ");
  assert.equal(args.at(-1), "ytsearch12:Apollo 11");
  assert.ok(args.includes("--flat-playlist"));
  assert.ok(args.includes("--dump-single-json"));
  assert.throws(() => buildSearchArgs("   "), /Enter something/);
});

test("search targets are cleaned of control characters and long input", () => {
  assert.equal(cleanQuery("a\u0000b\n c"), "a b c");
  assert.equal(cleanQuery("x".repeat(300), 20).length, 20);
});

test("video downloads cap the requested height and prefer playable codecs", () => {
  const args = buildDownloadArgs({
    target: "https://www.youtube.com/watch?v=abc",
    kind: "video",
    height: 1080,
    subtitleLanguage: "en-US",
    tempDir: "/tmp/puffin",
    ffmpegPath: "/ffmpeg",
  });
  const format = args[args.indexOf("-f") + 1];
  assert.match(format, /height<=1080/);
  assert.match(format, /avc1/);
  assert.ok(args.includes("--merge-output-format"));
  assert.equal(args[args.indexOf("--sub-langs") + 1], "en-us,en");
  assert.equal(args.at(-2), "--");
  assert.equal(args.at(-1), "https://www.youtube.com/watch?v=abc");
});

test("audio downloads request a playable audio-only format", () => {
  const args = buildDownloadArgs({
    target: "ytsearch1:lofi",
    kind: "audio",
    height: 720,
    tempDir: "/tmp/puffin",
    ffmpegPath: "/ffmpeg",
  });
  assert.match(args[args.indexOf("-f") + 1], /^ba\[ext=m4a\]/);
  assert.ok(!args.includes("--write-subs"));
  assert.equal(args.at(-1), "ytsearch1:lofi");
});

test("download progress lines become percentage, speed, and ETA", () => {
  const parsed = parseProgressLine("[download]  42.3% of  123.45MiB at    1.23MiB/s ETA 00:15");
  assert.deepEqual(parsed, { progress: 42.3, size: "123.45MiB", speed: "1.23MiB/s", eta: "00:15" });
  assert.equal(parseProgressLine("[download] Destination: file.mp4"), null);
});

test("search payloads are reduced to safe renderer fields", () => {
  const videos = parseSearchPayload({
    entries: [
      {
        id: "abc123",
        title: "A video",
        channel: "A channel",
        duration: 65,
        thumbnails: [{ url: "https://i.ytimg.com/vi/abc123/default.jpg" }],
      },
      { id: "no-title" },
    ],
  });
  assert.equal(videos.length, 1);
  assert.equal(videos[0].url, "https://www.youtube.com/watch?v=abc123");
  assert.equal(videos[0].channel, "A channel");
  assert.equal(videos[0].thumbnail, "https://i.ytimg.com/vi/abc123/default.jpg");
});

test("the finished media file is chosen without temporary or subtitle files", () => {
  assert.equal(selectMediaFile([
    "My video [id].f137.mp4.part",
    "My video [id].en.vtt",
    "My video [id].mp4",
    "final-path.txt",
  ]), "My video [id].mp4");
  assert.equal(selectMediaFile(["notes.txt"]), "");
  assert.equal(mediaMimeFor("My video.mp4"), "video/mp4");
  assert.equal(mediaMimeFor("My song.m4a"), "audio/mp4");
  assert.equal(mediaMimeFor("My song.webm", "audio"), "audio/webm");
  assert.equal(mediaMimeFor("My video.webm", "video"), "video/webm");
});

test("subtitles prefer the requested language and fall back to English", () => {
  assert.equal(pickSubtitleFile(["clip.en.vtt", "clip.es.vtt"], "es"), "clip.es.vtt");
  assert.equal(pickSubtitleFile(["clip.fr.vtt", "clip.en.vtt"], "de"), "clip.en.vtt");
  assert.equal(pickSubtitleFile(["clip.de.vtt"], "en"), "clip.de.vtt");
  assert.equal(subtitleLanguageFromFile("clip.en-US.vtt"), "en-US");
});
