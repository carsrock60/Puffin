import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRecordingMatch, mapRankedCandidates, selectHighConfidenceCandidate } from "../src/enrichment-confidence.js";

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

const originals = [
  { id: "a", title: "Astronaut in the Ocean", artist: "Masked Wolf", duration: 132 },
  { id: "b", title: "Astronaut in the Ocean", artist: "Wrong Artist", duration: 132 },
  { id: "c", title: "Astronaut in the Ocean", artist: "Masked Wolf", duration: 190 },
];
const ranking = { ranked_candidates: [
  { id: "b", score: .99, reason: "artist differs" },
  { id: "c", score: .96, reason: "duration differs" },
  { id: "a", score: .95, reason: "all fields align" },
] };

test("maps Groq score and reason back to full MusicBrainz candidates", () => {
  const mapped = mapRankedCandidates(originals, ranking);
  assert.equal(mapped[0].title, "Astronaut in the Ocean");
  assert.equal(mapped[0].artist, "Wrong Artist");
  assert.equal(mapped[0].duration, 132);
  assert.equal(mapped[0].aiScore, .99);
  assert.equal(mapped[0].aiReason, "artist differs");
});
test("accepts 95 percent only when independent fields agree", () => {
  assert.equal(evaluateRecordingMatch({ title: originals[0].title, artist: originals[0].artist, duration: 132, rawTitle: originals[0].title }, { ...originals[0], aiScore: .95 }), "high");
});
test("rejects high score for wrong artist or duration", () => {
  const track = { title: originals[0].title, artist: originals[0].artist, duration: 132, rawTitle: originals[0].title };
  assert.equal(evaluateRecordingMatch(track, { ...originals[1], aiScore: .99 }), "low");
  assert.equal(evaluateRecordingMatch(track, { ...originals[2], aiScore: .99 }), "low");
});
test("selects the highest-scoring candidate that passes all checks", () => {
  const track = { title: originals[0].title, artist: originals[0].artist, duration: 132, rawTitle: originals[0].title };
  assert.equal(selectHighConfidenceCandidate(track, originals, ranking).id, "a");
});
