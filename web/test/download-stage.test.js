import test from "node:test";
import assert from "node:assert/strict";
import { describeDownloadStage } from "../src/download-stage.js";

test("each named stage has its own label and explanation", () => {
  const preparing = describeDownloadStage({ status: "queued", stage: "preparing", progress: 0 });
  assert.equal(preparing.label, "Preparing download");
  assert.match(preparing.detail, /Checking the Pi/);

  const resolving = describeDownloadStage({ status: "downloading", stage: "resolving", progress: 0 });
  assert.equal(resolving.label, "Resolving media on the Pi");
  assert.match(resolving.detail, /YouTube/);

  const downloading = describeDownloadStage({ status: "downloading", stage: "downloading", progress: 0 });
  assert.equal(downloading.label, "Downloading on the Pi");
  assert.match(downloading.detail, /data from YouTube/);

  const processing = describeDownloadStage({ status: "downloading", stage: "processing", progress: 100 });
  assert.equal(processing.label, "Processing on the Pi");
  assert.match(processing.detail, /Creating|Converting|Combining/);
});

test("a download with progress reports the percentage, speed, and remaining time", () => {
  const described = describeDownloadStage({ status: "downloading", stage: "downloading", progress: 42.6, speed: "1.2MiB/s", eta: "00:15" });
  assert.equal(described.label, "Downloading on the Pi · 43%");
  assert.equal(described.detail, "1.2MiB/s · 00:15 remaining");
});

test("progress without a speed or ETA still explains the wait", () => {
  const described = describeDownloadStage({ status: "downloading", progress: 5 });
  assert.equal(described.label, "Downloading on the Pi · 5%");
  assert.match(described.detail, /Calculating transfer speed/);
});

test("converting keeps the processing wording even without a stage", () => {
  const described = describeDownloadStage({ status: "converting", progress: 99 });
  assert.equal(described.label, "Processing on the Pi");
});

test("terminal states are named instead of leaving a stale stage on screen", () => {
  assert.equal(describeDownloadStage({ status: "ready", stage: "completed", progress: 100 }).label, "Download complete on the Pi");
  const failed = describeDownloadStage({ status: "failed", stage: "failed", error: "The Pi ran out of space." });
  assert.equal(failed.label, "Download failed");
  assert.equal(failed.detail, "The Pi ran out of space.");
  assert.equal(describeDownloadStage({ status: "cancelled", stage: "cancelled" }).label, "Download cancelled");
  assert.equal(describeDownloadStage({ status: "queued" }).label, "Queued on the Pi");
});

test("an older Pi service that sends free-text stages still shows them", () => {
  const described = describeDownloadStage({ status: "downloading", stage: "Contacting YouTube", progress: 0 });
  assert.equal(described.label, "Downloading on the Pi");
  assert.equal(described.detail, "Contacting YouTube…");
});

test("a job without a stage falls back to a neutral waiting message", () => {
  const described = describeDownloadStage({ status: "downloading", progress: 0 });
  assert.equal(described.label, "Downloading on the Pi");
  assert.match(described.detail, /Waiting for the Pi/);
});
