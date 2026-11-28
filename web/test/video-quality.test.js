import test from "node:test";
import assert from "node:assert/strict";
import { VIDEO_QUALITIES, videoHeightForSliderValue, videoHeightLabel, videoQualityLabel } from "../src/video-quality.js";

test("every slider stop maps to the matching requested video height", () => {
  assert.deepEqual(VIDEO_QUALITIES.map((_, index) => videoHeightForSliderValue(index)), [240, 360, 480, 720, 1080, 1440, 2160]);
});

test("slider labels correspond to the selected output height", () => {
  assert.deepEqual(VIDEO_QUALITIES.map((_, index) => videoQualityLabel(index)), ["240p", "360p", "480p", "720p", "1080p", "1440p", "4K"]);
});

test("download resolution labels format verified heights", () => {
  assert.equal(videoHeightLabel(720), "720p");
  assert.equal(videoHeightLabel(2160), "4K");
});

test("invalid slider values safely use the existing 720p default", () => {
  assert.equal(videoHeightForSliderValue("bad"), 720);
  assert.equal(videoHeightForSliderValue(9), 720);
});
