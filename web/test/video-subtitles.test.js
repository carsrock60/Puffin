import test from "node:test";
import assert from "node:assert/strict";
import { createSubtitleController, getActiveSubtitleText, parseWebVtt } from "../src/video-subtitles.js";

const sampleVtt = `WEBVTT\nKind: captions\nLanguage: en\n\nintro\n00:00:01.000 --> 00:00:02.500 align:start position:0%\n<c>Hello &amp; welcome</c>\n\n00:00:02.500 --> 00:00:04.000\n<v Puffin speaker>Next line</v>\n`;

test("parses WebVTT cue IDs, settings, markup, and entities", () => {
  const result = parseWebVtt(sampleVtt);
  assert.equal(result.error, null);
  assert.equal(result.invalidCueCount, 0);
  assert.deepEqual(result.cues, [
    { start: 1, end: 2.5, text: "Hello & welcome" },
    { start: 2.5, end: 4, text: "Puffin speaker: Next line" },
  ]);
});

test("selects active cues with an inclusive start and exclusive end", () => {
  const { cues } = parseWebVtt(sampleVtt);
  assert.equal(getActiveSubtitleText(cues, 0.999), "");
  assert.equal(getActiveSubtitleText(cues, 1), "Hello & welcome");
  assert.equal(getActiveSubtitleText(cues, 2.5), "Puffin speaker: Next line");
  assert.equal(getActiveSubtitleText(cues, 4), "");
});

test("CC toggling updates a mocked overlay repeatedly and keeps cue timing", () => {
  const { cues } = parseWebVtt(sampleVtt);
  const overlay = { hidden: true, textContent: "" };
  const controller = createSubtitleController(cues, ({ text, visible }) => {
    overlay.textContent = visible ? text : "";
    overlay.hidden = !visible;
  });

  assert.equal(controller.available, true);
  assert.equal(controller.enabled, false);
  controller.update(1.25);
  assert.equal(overlay.hidden, true);

  assert.equal(controller.toggle(), true);
  controller.update(1.25);
  assert.deepEqual(overlay, { hidden: false, textContent: "Hello & welcome" });

  assert.equal(controller.toggle(), false);
  controller.update(1.25);
  assert.deepEqual(overlay, { hidden: true, textContent: "" });

  assert.equal(controller.toggle(), true);
  controller.update(2.75);
  assert.deepEqual(overlay, { hidden: false, textContent: "Puffin speaker: Next line" });
});

test("rejects empty, unsupported, and malformed subtitle files", () => {
  assert.equal(parseWebVtt("").error, "empty");
  assert.equal(parseWebVtt("not a subtitle file").error, "missing-webvtt-header");
  assert.deepEqual(parseWebVtt("WEBVTT\n\n00:00:bad --> 00:00:02.000\nMissing time\n"), {
    cues: [], error: "no-valid-cues", invalidCueCount: 1,
  });
});
