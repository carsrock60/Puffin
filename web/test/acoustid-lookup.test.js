import test from "node:test";
import assert from "node:assert/strict";
import { lookupAcoustID } from "../src/audio-fingerprint.js";

async function withFetch(fakeFetch, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("the AcoustID key travels in the POST body, never in the request URL", async () => {
  const calls = [];
  const results = await withFetch(async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({ status: "ok", results: [{ id: "recording-1" }] });
  }, () => lookupAcoustID({ client: "application-key-123", duration: 12.4, fingerprint: "AQAA" }));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.acoustid.org/v2/lookup");
  assert.equal(calls[0].options.method, "POST");
  assert.doesNotMatch(calls[0].url, /application-key-123/);

  const body = new URLSearchParams(String(calls[0].options.body));
  assert.equal(body.get("client"), "application-key-123");
  assert.equal(body.get("fingerprint"), "AQAA");
  assert.equal(body.get("duration"), "12");
  assert.equal(body.get("format"), "json");
  assert.deepEqual(results, [{ id: "recording-1" }]);
});

test("AcoustID API errors are reported with the service message", async () => {
  await withFetch(async () => jsonResponse({ status: "error", error: { message: "invalid API key" } }), async () => {
    await assert.rejects(
      () => lookupAcoustID({ client: "bad", duration: 30, fingerprint: "AQAA" }),
      /invalid API key/,
    );
  });
});

test("a network failure is reported without leaking request details", async () => {
  await withFetch(async () => { throw new TypeError("Failed to fetch"); }, async () => {
    await assert.rejects(
      () => lookupAcoustID({ client: "application-key-123", duration: 30, fingerprint: "AQAA" }),
      (error) => error.message === "Could not reach AcoustID." && !error.message.includes("application-key-123"),
    );
  });
});
