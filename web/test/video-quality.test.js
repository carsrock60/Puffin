import test from "node:test";
import assert from "node:assert/strict";
import { VIDEO_QUALITIES, videoHeightForSliderValue, videoQualityLabel, piSupportsVideoQuality } from "../src/video-quality.js";

test("every slider stop maps to the matching requested video height", () => {
  assert.deepEqual(VIDEO_QUALITIES.map((_, index) => videoHeightForSliderValue(index)), [240, 360, 480, 720, 1080, 1440, 2160]);
});

test("slider labels correspond to the selected output height", () => {
  assert.deepEqual(VIDEO_QUALITIES.map((_, index) => videoQualityLabel(index)), ["240p", "360p", "480p", "720p", "1080p", "1440p", "4K"]);
});

test("invalid slider values safely use the existing 720p default", () => {
  assert.equal(videoHeightForSliderValue("bad"), 720);
  assert.equal(videoHeightForSliderValue(9), 720);
});

test("video downloads require a Pi service that advertises the selected quality", () => {
  const currentPi = { video_quality_options: [...VIDEO_QUALITIES] };
  assert.equal(piSupportsVideoQuality(currentPi, 240), true);
  assert.equal(piSupportsVideoQuality(currentPi, 2160), true);
  assert.equal(piSupportsVideoQuality({ ok: true }, 240), false);
  assert.equal(piSupportsVideoQuality({ video_quality_options: [240, 720] }, 2160), false);
});
