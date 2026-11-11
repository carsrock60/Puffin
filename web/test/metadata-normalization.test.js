import test from "node:test";
import assert from "node:assert/strict";
import { cleanYoutubeTitle, stripYoutubeId } from "../src/metadata-normalization.js";

test("removes a YouTube id and promotional wording", () => {
  assert.equal(stripYoutubeId("Artist - Song [abcdefghijk].mp3"), "Artist - Song.mp3");
  assert.equal(cleanYoutubeTitle("Artist - Song (Official Music Video)"), "Artist - Song");
});

test("preserves meaningful version labels", () => {
  assert.match(cleanYoutubeTitle("Artist - Song (Live Acoustic Remix) Official Audio"), /Live Acoustic Remix/);
});
