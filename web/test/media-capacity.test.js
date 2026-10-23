import assert from "node:assert/strict";
import test from "node:test";
import { assertMediaFits, getMediaCapacityState, guardReadyPiDownload } from "../src/media-capacity.js";

test("imports may use the last byte of the configured media limit", () => {
  const state = assertMediaFits(900, 1000, 100);

  assert.equal(state.remainingBytes, 100);
  assert.equal(getMediaCapacityState(1000, 1000).isAtLimit, true);
});

test("an import is rejected before it can exceed the configured limit", () => {
  assert.throws(
    () => assertMediaFits(900, 1000, 101),
    /Not enough Puffin media storage/,
  );
});

test("an over-limit existing library rejects additional imports", () => {
  const state = getMediaCapacityState(1200, 1000);

  assert.equal(state.isOverLimit, true);
  assert.throws(() => assertMediaFits(state.usedBytes, state.limitBytes, 1), /Not enough Puffin media storage/);
});

test("a Pi download that will not fit is cancelled before transfer", async () => {
  let cancelled = false;
  await assert.rejects(
    guardReadyPiDownload({
      fileSize: 101,
      assertCapacity: async () => { throw new Error("Media limit reached"); },
      cancelDownload: async () => { cancelled = true; },
    }),
    /Media limit reached/,
  );

  assert.equal(cancelled, true);
});

test("a Pi download that fits is allowed and is not cancelled", async () => {
  let cancelled = false;
  await guardReadyPiDownload({
    fileSize: 100,
    assertCapacity: async () => ({ remainingBytes: 100 }),
    cancelDownload: async () => { cancelled = true; },
  });

  assert.equal(cancelled, false);
});

test("Pi cleanup problems are included in the capacity error", async () => {
  await assert.rejects(
    guardReadyPiDownload({
      fileSize: 101,
      assertCapacity: async () => { throw new Error("Media limit reached"); },
      cancelDownload: async () => { throw new Error("Network unavailable"); },
    }),
    /temporary copy will expire automatically/,
  );
});
