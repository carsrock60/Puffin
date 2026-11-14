import test from "node:test";
import assert from "node:assert/strict";
import { identify } from "../src/enrichment.js";

test("the actual identification path validates a ranked MusicBrainz recording", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (url === "/api/smart-fill/normalize") return { ok: true, json: async () => ({ title: "Astronaut in the Ocean", artist: "Masked Wolf", confidence: 0.98 }) };
    if (String(url).startsWith("https://musicbrainz.org/")) return { ok: true, json: async () => ({ recordings: [{ id: "abc", title: "Astronaut in the Ocean", length: 132000, score: 100, "artist-credit": [{ name: "Masked Wolf" }] }] }) };
    if (url === "/api/smart-fill/rank") return { ok: true, json: async () => ({ ranked_candidates: [{ id: "abc", score: 0.95, reason: "match" }] }) };
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const result = await identify({ rawTitle: "Masked Wolf - Astronaut in the Ocean", name: "song.m4a" }, "", "", 132);
    assert.equal(result.candidate.id, "abc");
    assert.equal(result.candidate.title, "Astronaut in the Ocean");
    assert.equal(result.candidate.aiScore, 0.95);
    assert.equal(requests.length, 3);
  } finally { globalThis.fetch = originalFetch; }
});

test("automatic identification searches the cleaned title if normalization is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === "/api/smart-fill/normalize") return { ok: false, status: 503 };
    if (String(url).startsWith("https://musicbrainz.org/")) {
      assert.match(new URL(url).searchParams.get("query"), /recording:"Astronaut in the Ocean" AND artist:"Masked Wolf"/);
      return { ok:true, json:async()=>({recordings:[{id:"abc",title:"Astronaut in the Ocean",length:132000,score:100,"artist-credit":[{name:"Masked Wolf"}]}]}) };
    }
    if (url === "/api/smart-fill/rank") return {ok:true,json:async()=>({ranked_candidates:[{id:"abc",score:.95,reason:"match"}]})};
    throw Error(`Unexpected request: ${url}`);
  };
  try {
    const result = await identify({rawTitle:"Masked Wolf - Astronaut in the Ocean (Official Music Video)",name:"song.m4a"}, "", "", 132);
    assert.equal(result.candidate.id,"abc");
  } finally { globalThis.fetch = originalFetch; }
});
