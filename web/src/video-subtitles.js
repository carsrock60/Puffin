const WEBVTT_HEADER = /^WEBVTT(?:[ \t].*)?$/i;

function parseTimestamp(value) {
  const parts = value.split(":");
  if (parts.length !== 2 && parts.length !== 3) return NaN;
  const secondsPart = parts.pop();
  const secondsMatch = secondsPart.match(/^(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!secondsMatch) return NaN;
  const seconds = Number(secondsMatch[1]) + Number(`0.${(secondsMatch[2] || "0").padEnd(3, "0")}`);
  const minutes = Number(parts.pop());
  const hours = parts.length ? Number(parts.pop()) : 0;
  if (![hours, minutes, seconds].every(Number.isFinite)) return NaN;
  return hours * 3600 + minutes * 60 + seconds;
}

function decodeCueText(value) {
  const namedEntities = {
    amp: "&", apos: "'", gt: ">", lt: "<", lrm: "\u200e", nbsp: "\u00a0", quot: "\"", rlm: "\u200f",
  };
  return value
    .replace(/<v(?:\.[^ >]+)?\s+([^>]+)>/gi, "$1: ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, value) => {
      if (value[0] === "#") {
        const isHex = value[1]?.toLowerCase() === "x";
        const codePoint = Number.parseInt(value.slice(isHex ? 2 : 1), isHex ? 16 : 10);
        if (Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)) {
          return String.fromCodePoint(codePoint);
        }
        return entity;
      }
      return namedEntities[value.toLowerCase()] ?? entity;
    });
}

export function parseWebVtt(input) {
  if (typeof input !== "string" || !input.trim()) {
    return { cues: [], error: "empty", invalidCueCount: 0 };
  }

  const source = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const firstLine = source.slice(0, source.indexOf("\n") < 0 ? source.length : source.indexOf("\n")).trim();
  if (!WEBVTT_HEADER.test(firstLine)) {
    return { cues: [], error: "missing-webvtt-header", invalidCueCount: 0 };
  }

  const cues = [];
  let invalidCueCount = 0;
  const blocks = source.split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/i.test(lines[0].trim())) continue;
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;

    const timing = lines[timingIndex].match(/^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/);
    const start = timing ? parseTimestamp(timing[1]) : NaN;
    const end = timing ? parseTimestamp(timing[2]) : NaN;
    const text = decodeCueText(lines.slice(timingIndex + 1).join("\n")).trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) {
      invalidCueCount += 1;
      continue;
    }
    cues.push({ start, end, text });
  }

  cues.sort((left, right) => left.start - right.start || left.end - right.end);
  return {
    cues,
    error: cues.length ? null : "no-valid-cues",
    invalidCueCount,
  };
}

export function getActiveSubtitleText(cues, currentTime) {
  if (!Number.isFinite(currentTime) || !Array.isArray(cues)) return "";
  return cues
    .filter((cue) => currentTime >= cue.start && currentTime < cue.end)
    .map((cue) => cue.text)
    .join("\n");
}

export function createSubtitleController(cues, render = () => {}) {
  let enabled = false;
  const available = Array.isArray(cues) && cues.length > 0;

  function update(currentTime) {
    const text = available ? getActiveSubtitleText(cues, currentTime) : "";
    const state = { available, enabled, text, visible: enabled && Boolean(text) };
    render(state);
    return state;
  }

  return {
    cues,
    get available() { return available; },
    get enabled() { return enabled; },
    setEnabled(value) {
      enabled = available && Boolean(value);
      return enabled;
    },
    toggle() {
      enabled = available && !enabled;
      return enabled;
    },
    update,
  };
}
