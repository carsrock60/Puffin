export const ENRICHMENT_POLICY = Object.freeze({ minAiScore: 0.90, maxDurationDeltaSeconds: 3, aiTitleConfidence: 0.75 });
export function stripYoutubeId(value) { return String(value || "").replace(/\s*\[[\w-]{8,}\](?=\s|\.[^.]+$|$)/g, " ").replace(/\s+/g, " ").replace(/\s+\./g, ".").trim(); }
export function cleanYoutubeTitle(value) {
  return stripYoutubeId(value).replace(/\b(official\s+)?(music\s+video|audio|lyrics?|visuali[sz]er|4k|hd|official video|video clip)\b/gi, " ").replace(/[|–—]+\s*[^|–—]+$/g, " ").replace(/[()[\]{}]/g, " ").replace(/\s+/g, " ").trim();
}
