import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRecordingMatch } from "../src/enrichment-confidence.js";

const track = { title: "Example Song", artist: "Example Artist", duration: 200 };
const candidate = { ...track, aiScore: 0.95 };

test("requires title, artist, duration and ranking evidence", () => {
  assert.equal(evaluateRecordingMatch(track, candidate), "high");
  assert.equal(evaluateRecordingMatch(track, { ...candidate, artist: "Another Artist" }), "low");
  assert.equal(evaluateRecordingMatch(track, { ...candidate, duration: 220 }), "low");
  assert.equal(evaluateRecordingMatch(track, { ...candidate, aiScore: undefined }), "medium");
});

test("does not confuse live or remix versions with the original", () => {
  assert.equal(evaluateRecordingMatch(track, { ...candidate, title: "Example Song (Live)" }), "low");
  assert.equal(evaluateRecordingMatch(track, { ...candidate, title: "Example Song Remix" }), "low");
});
