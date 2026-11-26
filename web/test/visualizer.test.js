import test from "node:test";
import assert from "node:assert/strict";
import { createAnimationLoop, normalizeFrequencyLevel } from "../src/visualizer.js";

function mockFrames() {
  let nextId = 0;
  const pending = new Map();
  const cancelled = [];
  return {
    pending,
    cancelled,
    requestFrame(callback) {
      const id = ++nextId;
      pending.set(id, callback);
      return id;
    },
    cancelFrame(id) {
      cancelled.push(id);
      pending.delete(id);
    },
    runNext() {
      const [id, callback] = pending.entries().next().value || [];
      if (!callback) return false;
      pending.delete(id);
      callback();
      return true;
    },
  };
}

test("visualizer loop keeps one frame chain and restarts on play after pause", () => {
  const frames = mockFrames();
  let playing = true;
  let draws = 0;
  const loop = createAnimationLoop({
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
    canRun: () => playing,
    onFrame: () => { draws += 1; },
  });

  loop.start();
  loop.start();
  assert.equal(frames.pending.size, 1);
  frames.runNext();
  assert.equal(draws, 1);
  assert.equal(frames.pending.size, 1);

  playing = false;
  loop.stop();
  assert.equal(frames.pending.size, 0);
  assert.equal(frames.cancelled.length, 1);

  playing = true;
  loop.start();
  assert.equal(frames.pending.size, 1);
  frames.runNext();
  assert.equal(draws, 2);
  assert.equal(frames.pending.size, 1);
});

test("a cancelled stale frame cannot create a second chain after track replacement", () => {
  const frames = mockFrames();
  let playing = true;
  let draws = 0;
  const loop = createAnimationLoop({
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
    canRun: () => playing,
    onFrame: () => { draws += 1; },
  });

  loop.start();
  const staleFrame = frames.pending.values().next().value;
  loop.stop();
  loop.start();
  assert.equal(frames.pending.size, 1);

  staleFrame();
  assert.equal(draws, 0);
  assert.equal(frames.pending.size, 1);
  frames.runNext();
  assert.equal(draws, 1);
  assert.equal(frames.pending.size, 1);
});

test("frequency normalization gives a clear bounded response from quiet sections to strong peaks", () => {
  const silence = normalizeFrequencyLevel(Uint8Array.of(0, 0, 0), 0, 3);
  const quiet = normalizeFrequencyLevel(Uint8Array.of(12, 15, 18, 20), 0, 4);
  const beat = normalizeFrequencyLevel(Uint8Array.of(0, 0, 105, 0), 0, 4);
  const loud = normalizeFrequencyLevel(Uint8Array.of(150, 175, 200, 220), 0, 4);

  assert.equal(silence, 0.12);
  assert.ok(quiet > 0.35, `quiet audio should be visibly above idle, got ${quiet}`);
  assert.ok(beat > quiet, `transient peak ${beat} should rise above quiet audio ${quiet}`);
  assert.ok(loud > beat, `sustained loud audio ${loud} should exceed a single-bin beat ${beat}`);
  assert.ok(loud <= 1);
  assert.equal(normalizeFrequencyLevel(Uint8Array.of(255), 1, 1), 0.12);
});
