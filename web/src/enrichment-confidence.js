// Conservative evidence gate for automatic matches. Scores from search or AI
// are ranking hints, not proof that two recordings are the same.
const normalize = (value) => String(value || "").normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const versions = /\b(remix|live|instrumental|acoustic|karaoke|demo|remaster(?:ed)?|clean|explicit|radio edit)\b/g;

export function evaluateRecordingMatch(track, candidate) {
  const title = normalize(track.title), candidateTitle = normalize(candidate.title);
  const artist = normalize(track.artist), candidateArtist = normalize(candidate.artist);
  const leftVersions = [...title.matchAll(versions)].map((item) => item[0]).sort().join("|");
  const rightVersions = [...candidateTitle.matchAll(versions)].map((item) => item[0]).sort().join("|");
  if (!title || !artist || !candidateTitle || !candidateArtist || leftVersions !== rightVersions) return "low";
  if (title !== candidateTitle || artist !== candidateArtist) return "low";
  const duration = Number(track.duration), matchDuration = Number(candidate.duration);
  if (!(duration > 0 && matchDuration > 0)) return "medium";
  const difference = Math.abs(duration - matchDuration);
  if (difference > 10) return "low";
  if (difference > 3 || Number(candidate.aiScore) < 0.9 || !Number.isFinite(Number(candidate.aiScore))) return "medium";
  return "high";
}
