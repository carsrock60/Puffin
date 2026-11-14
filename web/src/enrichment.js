import { applyEnrichmentUpdate, getMediaBlob, listMediaFiles } from "./library.js";
import { fetchSyncedLyrics } from "./lyrics.js";
import { cleanYoutubeTitle, fetchMusicBrainz, normalizeTrackTitle, searchMusicBrainzRecordings } from "./metadata-normalization.js";
import { selectHighConfidenceCandidate } from "./enrichment-confidence.js";

const jobs = new Map();
const timeout = (ms = 12000) => AbortSignal.timeout(ms);
const isTemporaryServiceError = (error) => [408, 429, 500, 502, 503, 504].includes(error?.status)
  || ["TypeError", "TimeoutError", "AbortError"].includes(error?.name)
  || /temporarily unavailable|normalization unavailable|ranking unavailable|MusicBrainz returned (408|429|500|502|503|504)/i.test(error?.message || "");
const retryDelay = (error, attempt) => Math.min(60 * 60 * 1000, Math.max(error?.retryAfterMs || 0, 60_000 * (2 ** Math.max(0, attempt - 1))));
function durationOf(blob) {
  return new Promise((resolve) => { const el = document.createElement("audio"), url = URL.createObjectURL(blob); el.preload = "metadata"; el.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(el.duration); }; el.onerror = () => { URL.revokeObjectURL(url); resolve(NaN); }; el.src = url; });
}
function validImage(data) { return new Promise((resolve) => { const img = new Image(); img.onload = () => resolve(img.naturalWidth > 0 && img.naturalHeight > 0); img.onerror = () => resolve(false); img.src = data; }); }
export async function identify(record, title, artist, duration) {
  const normalized = await normalizeTrackTitle(record.rawTitle || record.name.replace(/\.[^.]+$/, ""));
  if (!normalized.title || !normalized.artist) throw Error("Could not identify both a title and artist; use Smart Fill to review this track.");
  const primaryArtist = normalized.artist.split(/[,;&/]|\b(?:feat\.?|ft\.?)\b/i)[0].trim();
  const candidates = (await searchMusicBrainzRecordings({ title: normalized.title, artist: primaryArtist })).recordings || [];
  const originals = candidates.slice(0, 6).map((c) => ({ id:c.id,title:c.title,artist:(c["artist-credit"] || []).map((x)=>typeof x === "string" ? x : `${x.name || x.artist?.name || ""}${x.joinphrase || ""}`).join(""),duration:c.length ? c.length/1000 : null,search_score:(c.score || 0)/100 }));
  if (!originals.length) throw Error("No recordings found");
  const rankedPayload = originals.map((c) => ({ ...c, title:c.title.slice(0,240), artist:c.artist.slice(0,240), duration:Number.isFinite(c.duration)&&c.duration>0?c.duration:null }));
  const rankResponse = await fetch("/api/smart-fill/rank", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ title:normalized.title.slice(0,240),artist:normalized.artist.slice(0,240),duration:Number.isFinite(duration)&&duration>0?duration:null,candidates:rankedPayload }),signal:timeout(16000) });
  if (!rankResponse.ok) {
    const detail = (await rankResponse.text()).slice(0,300);
    throw Error(`Groq ranking unavailable (${rankResponse.status})${detail ? `: ${detail}` : ""}`);
  }
  const ranked = await rankResponse.json();
  const matching = {title:normalized.title,artist:normalized.artist,duration,rawTitle:record.rawTitle || record.name};
  const candidate = selectHighConfidenceCandidate(matching, originals, ranked);
  if (!candidate) throw Error("No candidate passed the 90% independent match checks");
  return { normalized, candidate };
}
async function run(record) {
  if (jobs.has(record.id)) return jobs.get(record.id);
  const task = (async () => {
    let current = record;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const stamp = current.updatedAt || null;
        await applyEnrichmentUpdate(record.id, {}, stamp, { status:"identifying", overall:"identifying", attempt:attempt+1, startedAt:Date.now() });
        current = (await listMediaFiles()).find((x)=>x.id===record.id) || current;
        const blob = await getMediaBlob(record.id); if (!blob) return;
        const duration = await durationOf(blob);
        const raw = current.rawTitle || current.name.replace(/\.[^.]+$/, "");
        const cleaned = cleanYoutubeTitle(raw);
        let accepted;
        try { accepted = await identify(current, cleaned, current.artist || "", duration); }
        catch (error) {
          if (error.status === 429 || error.status === 503 || error.name === "TypeError" || /temporarily unavailable|normalization unavailable|ranking unavailable/i.test(error.message)) throw error;
          await applyEnrichmentUpdate(record.id, {}, stamp, { status:"needs_review", overall:"needs_review", metadata:"needs_review", lastError:String(error.message), attemptedAt:Date.now() });
          return;
        }
        const detailResponse = await fetchMusicBrainz(`https://musicbrainz.org/ws/2/recording/${accepted.candidate.id}?fmt=json&inc=releases`, { headers:{Accept:"application/json"},signal:timeout(15000) });
        const detail = await detailResponse.json(), release=detail.releases?.[0];
        const credits=(detail["artist-credit"]||[]).map((x)=>typeof x === "string" ? x : `${x.name || x.artist?.name || ""}${x.joinphrase || ""}`).join("").trim();
        const meta={title:detail.title||accepted.normalized.title,artist:credits||accepted.normalized.artist};
        if(release?.title)meta.album=release.title;
        if(release?.date)meta.year=release.date.slice(0,4);
        if(Number(detail.length)>0)meta.duration=Math.round(detail.length/1000);
        const updates={...meta,normalizedTitle:accepted.normalized.title}; let outcomes={overall:"enriching",metadata:"completed",artwork:"unavailable",lyrics:"unavailable"};
        if(release?.id)try{const image=await fetch(`https://coverartarchive.org/release/${release.id}/front-500`,{signal:timeout()});if(image.ok){const blobImage=await image.blob();if(blobImage.type.startsWith("image/")){const data=await new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>resolve(fr.result);fr.onerror=reject;fr.readAsDataURL(blobImage);});if(await validImage(data)){updates.artwork=data;outcomes.artwork="completed";}}}}catch{}
        try{const lyric=await fetchSyncedLyrics({trackName:meta.title,artistName:meta.artist,albumName:meta.album||"",duration});if(lyric?.syncedLyrics){updates.syncedLyrics=lyric.syncedLyrics;updates.lyricsProvider="LRCLIB";updates.lyricsRecordId=lyric.id;outcomes.lyrics="completed";}}catch{}
        outcomes.overall="completed";
        outcomes.status="completed";
        await applyEnrichmentUpdate(record.id,updates,stamp,outcomes); return;
      } catch(error) {
        const retryCount = Number(current.enrichment?.retryCount || 0) + 1;
        if (isTemporaryServiceError(error)) {
          const delay = retryDelay(error, retryCount);
          const nextRetryAt = Date.now() + delay;
          await applyEnrichmentUpdate(record.id, {}, current.updatedAt || null, { status:"pending", overall:"pending", retryCount, nextRetryAt, lastError:String(error.message), attemptedAt:Date.now() }).catch(()=>{});
          setTimeout(() => { void listMediaFiles().then((records) => { const latest = records.find((item) => item.id === record.id); if (latest?.enrichment?.status === "pending") void run(latest); }); }, delay);
          return;
        } else {
          await applyEnrichmentUpdate(record.id,{},current.updatedAt||null,{status:attempt===2?"failed":"pending",overall:attempt===2?"failed":"pending",retryCount,lastError:String(error.message),attemptedAt:Date.now()}).catch(()=>{});
          if(attempt<2) await new Promise((resolve)=>setTimeout(resolve,1000*(attempt+1)));
        }
      }
    }
  })().finally(()=>jobs.delete(record.id));
  jobs.set(record.id,task); return task;
}
export function initializeEnrichment() {
  window.addEventListener("puffin:download-saved", (event)=>{const record=event.detail;if(record?.kind==="audio")void run(record);});
  void listMediaFiles().then((records)=>records.filter((r)=>r.enrichment?.status==="pending"||r.enrichment?.status==="identifying"||r.enrichment?.status==="enriching"||(r.enrichment?.status==="failed"&&isTemporaryServiceError({message:r.enrichment?.lastError}))).forEach((r)=>{
    const delay = Math.max(0, Number(r.enrichment?.nextRetryAt || 0) - Date.now());
    if (delay) setTimeout(() => { void run(r); }, delay);
    else void run(r);
  }));
}
