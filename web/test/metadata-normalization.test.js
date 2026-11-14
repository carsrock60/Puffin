import test from "node:test";
import assert from "node:assert/strict";
import { cleanYoutubeTitle, normalizeTrackTitle, searchMusicBrainzRecordings, stripYoutubeId } from "../src/metadata-normalization.js";

test("removes a YouTube id and promotional wording", () => {
  assert.equal(stripYoutubeId("Artist - Song [abcdefghijk].mp3"), "Artist - Song.mp3");
  assert.equal(cleanYoutubeTitle("Artist - Song (Official Music Video)"), "Artist - Song");
});

test("normalizes a YouTube artist and track title", async () => {
  const normalized = await normalizeTrackTitle("Masked Wolf - Astronaut in the Ocean (Official Music Video)", async () => ({ ok:true, json:async()=>({ title:"Astronaut in the Ocean", artist:"Masked Wolf", version:"", confidence:.97 }) }));
  assert.equal(normalized.title, "Astronaut in the Ocean");
  assert.equal(normalized.artist, "Masked Wolf");
});

test("manual MusicBrainz search sends normalized title and artist", async () => {
  let requested;
  await searchMusicBrainzRecordings({title:"Astronaut in the Ocean", artist:"Masked Wolf"}, async (url) => { requested=url; return {ok:true,json:async()=>({recordings:[]})}; });
  const query = new URL(requested).searchParams.get("query");
  assert.match(query, /recording:"Astronaut in the Ocean" AND artist:"Masked Wolf"/);
});

test("normalization failure uses cleaned original title and parsed artist safely", async () => {
  const result = await normalizeTrackTitle("Masked Wolf - Astronaut in the Ocean [abcdefghijk] Official Audio", async () => { throw Error("offline"); });
  assert.equal(result.title, "Astronaut in the Ocean");
  assert.equal(result.artist, "Masked Wolf");
  assert.equal(result.confidence, 0);
});

test("preserves meaningful version labels", () => {
  assert.match(cleanYoutubeTitle("Artist - Song (Live Acoustic Remix) Official Audio"), /Live Acoustic Remix/);
});
