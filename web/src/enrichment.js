import { applyEnrichmentUpdate, getMediaBlob, updateMediaMetadata, listMediaFiles } from "./library.js";
import { fetchSyncedLyrics } from "./lyrics.js";
import { cleanYoutubeTitle, ENRICHMENT_POLICY } from "./metadata-normalization.js";
import { evaluateRecordingMatch } from "./enrichment-confidence.js";

const jobs = new Map();
const timeout = (ms = 12000) => AbortSignal.timeout(ms);
function durationOf(blob) {
  return new Promise((resolve) => { const el = document.createElement("audio"), url = URL.createObjectURL(blob); el.preload = "metadata"; el.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(el.duration); }; el.onerror = () => { URL.revokeObjectURL(url); resolve(NaN); }; el.src = url; });
}
function validImage(data) { return new Promise((resolve) => { const img = new Image(); img.onload = () => resolve(img.naturalWidth > 0 && img.naturalHeight > 0); img.onerror = () => resolve(false); img.src = data; }); }
async function identify(record, title, artist, duration) {
  const normalized = await fetch("/api/smart-fill/normalize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw_title: record.rawTitle || record.name.replace(/\.[^.]+$/, "") }), signal: timeout() }).then((r) => { if (!r.ok) throw Error("Normalization unavailable"); return r.json(); });
  if (normalized.confidence < ENRICHMENT_POLICY.aiTitleConfidence || !normalized.artist) throw Error("Title identification is uncertain");
  const response = await fetch(`https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(`recording:"${normalized.title}" AND artist:"${normalized.artist}"`)}&fmt=json&limit=8`, { headers: { Accept: "application/json" }, signal: timeout(15000) });
  if (!response.ok) throw Error(`MusicBrainz returned ${response.status}`);
  const candidates = (await response.json()).recordings || [];
  const rankedPayload = candidates.slice(0, 8).map((c) => ({ id:c.id,title:c.title,artist:(c["artist-credit"] || []).map((x)=>typeof x === "string" ? x : `${x.name || x.artist?.name || ""}${x.joinphrase || ""}`).join(""),duration:c.length ? c.length/1000 : null,search_score:(c.score || 0)/100 }));
  if (!rankedPayload.length) throw Error("No recordings found");
  const ranked = await fetch("/api/smart-fill/rank", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ title:normalized.title,artist:normalized.artist,duration,candidates:rankedPayload }),signal:timeout(16000) }).then((r)=>{if(!r.ok)throw Error("Groq ranking unavailable");return r.json();});
  const sorted = (ranked.ranked_candidates || []).sort((a,b)=>b.score-a.score);
  const candidate = sorted.find((x)=>Number(x.score) >= ENRICHMENT_POLICY.minAiScore);
  if (!candidate || candidate.score < ENRICHMENT_POLICY.minAiScore) throw Error("No 90% match");
  const matching = {title:normalized.title,artist:normalized.artist,duration,rawTitle:record.rawTitle || record.name};
  if (evaluateRecordingMatch(matching,{title:candidate.title,artist:candidate.artist,duration:candidate.duration,aiScore:candidate.score}) !== "high") throw Error("Independent match checks failed");
  return { normalized, candidate };
}
async function run(record) {
  if (jobs.has(record.id)) return jobs.get(record.id);
  const task = (async () => {
    let current = record;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const stamp = current.updatedAt || null;
        await updateMediaMetadata(record.id, { enrichment: { status:"identifying", attempt:attempt+1, startedAt:Date.now() } });
        current = (await listMediaFiles()).find((x)=>x.id===record.id) || current;
        const blob = await getMediaBlob(record.id); if (!blob) return;
        const duration = await durationOf(blob);
        const raw = current.rawTitle || current.name.replace(/\.[^.]+$/, "");
        const cleaned = cleanYoutubeTitle(raw);
        let accepted;
        try { accepted = await identify(current, cleaned, current.artist || "", duration); }
        catch (error) {
          await applyEnrichmentUpdate(record.id, {}, stamp, { overall:"needs_review", metadata:"needs_review", lastError:String(error.message), attemptedAt:Date.now() });
          return;
        }
        const detailResponse = await fetch(`https://musicbrainz.org/ws/2/recording/${accepted.candidate.id}?fmt=json&inc=releases`, { headers:{Accept:"application/json"},signal:timeout(15000) });
        if (!detailResponse.ok) throw Error("Recording details unavailable");
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
        await applyEnrichmentUpdate(record.id,updates,stamp,outcomes); return;
      } catch(error) {
        await applyEnrichmentUpdate(record.id,{},current.updatedAt||null,{overall:attempt===2?"failed":"pending",retryCount:attempt+1,lastError:String(error.message),attemptedAt:Date.now()}).catch(()=>{});
        if(attempt<2)await new Promise((resolve)=>setTimeout(resolve,1000*(attempt+1)));
      }
    }
  })().finally(()=>jobs.delete(record.id));
  jobs.set(record.id,task); return task;
}
export function initializeEnrichment() {
  window.addEventListener("puffin:download-saved", (event)=>{const record=event.detail;if(record?.kind==="audio")void run(record);});
  void listMediaFiles().then((records)=>records.filter((r)=>r.enrichment?.status==="pending"||r.enrichment?.status==="identifying"||r.enrichment?.status==="enriching").forEach((r)=>void run(r)));
}
