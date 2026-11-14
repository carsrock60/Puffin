// Conservative evidence gate for automatic matches. Scores from search or AI
// are ranking hints, not proof that two recordings are the same.
const normalize = (value) => String(value || "").normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const versions = /\b(remix|live|instrumental|acoustic|karaoke|demo|remaster(?:ed)?|clean|explicit|radio edit)\b/g;
import { ENRICHMENT_POLICY, stripYoutubeId } from "./metadata-normalization.js";

export function evaluateRecordingMatch(track, candidate) {
  if (/\b(live|remix|instrumental)\b/i.test(stripYoutubeId(track.rawTitle || track.title))) return "low";
  const title = normalize(stripYoutubeId(track.title)), candidateTitle = normalize(candidate.title);
  const artist = normalize(track.artist), candidateArtist = normalize(candidate.artist);
  const leftVersions = [...title.matchAll(versions)].map((item) => item[0]).sort().join("|");
  const rightVersions = [...candidateTitle.matchAll(versions)].map((item) => item[0]).sort().join("|");
  if (!title || !artist || !candidateTitle || !candidateArtist || leftVersions !== rightVersions) return "low";
  if (title !== candidateTitle || artist !== candidateArtist) return "low";
  const duration = Number(track.duration), matchDuration = Number(candidate.duration);
  if (!(duration > 0 && matchDuration > 0)) return "medium";
  const difference = Math.abs(duration - matchDuration);
  if (difference > ENRICHMENT_POLICY.maxDurationDeltaSeconds) return "low";
  if (Number(candidate.aiScore) < ENRICHMENT_POLICY.minAiScore || !Number.isFinite(Number(candidate.aiScore))) return "medium";
  return "high";
}

export function mapRankedCandidates(originals, ranking) {
  const byId = new Map(originals.map((candidate) => [candidate.id, candidate]));
  return (ranking?.ranked_candidates || []).flatMap((ranked) => {
    const original = byId.get(ranked.id);
    return original ? [{ ...original, aiScore: ranked.score, aiReason: ranked.reason }] : [];
  }).sort((a, b) => b.aiScore - a.aiScore);
}

export function selectHighConfidenceCandidate(track, originals, ranking) {
  return mapRankedCandidates(originals, ranking).find((candidate) => evaluateRecordingMatch(track, candidate) === "high") || null;
}
