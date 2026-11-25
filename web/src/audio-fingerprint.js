const FINGERPRINT_LIMIT_SECONDS = 120;
let fingerprintWorker;
let nextWorkerRequest = 1;
const workerRequests = new Map();

function getFingerprintWorker() {
  if (!fingerprintWorker) {
    fingerprintWorker = new Worker(new URL("./chromaprint-worker.js", import.meta.url), { type: "module" });
    fingerprintWorker.addEventListener("message", ({ data }) => {
      const request = workerRequests.get(data.id);
      if (!request) return;
      workerRequests.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.fingerprint);
    });
    fingerprintWorker.addEventListener("error", (event) => {
      for (const request of workerRequests.values()) request.reject(new Error(event.message || "Browser fingerprinting failed."));
      workerRequests.clear();
      fingerprintWorker?.terminate();
      fingerprintWorker = undefined;
    });
  }
  return fingerprintWorker;
}

async function fingerprintSamples(buffer) {
  const frameLimit = Math.min(buffer.length, Math.floor(buffer.sampleRate * FINGERPRINT_LIMIT_SECONDS));
  const channelCount = Math.min(buffer.numberOfChannels, 2);
  const channels = Array.from({ length: channelCount }, (_, index) => buffer.getChannelData(index).slice(0, frameLimit));
  const transfer = channels.map((channel) => channel.buffer);
  const id = nextWorkerRequest++;
  const result = new Promise((resolve, reject) => workerRequests.set(id, { resolve, reject }));
  try {
    getFingerprintWorker().postMessage({
      id,
      sampleRate: buffer.sampleRate,
      channels: transfer,
    }, transfer);
  } catch (error) {
    workerRequests.delete(id);
    throw error;
  }
  return result;
}

export async function fingerprintAudioBlob(blob) {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) throw new Error("This browser cannot decode audio for fingerprinting.");
  const context = new AudioContextClass();
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    if (!buffer.length || !buffer.numberOfChannels) throw new Error("The audio file has no decodable samples.");
    const fingerprint = await fingerprintSamples(buffer);
    return { fingerprint, duration: buffer.duration };
  } finally {
    await context.close().catch(() => {});
  }
}

const ACOUSTID_LOOKUP_URL = "https://api.acoustid.org/v2/lookup";

/**
 * AcoustID takes the application key as a request parameter. Sending it in a
 * POST body instead of a JSONP URL keeps it out of browser URLs, proxy logs,
 * and monitoring traces, which is why this no longer injects a script tag.
 */
export async function lookupAcoustID({ client, duration, fingerprint }) {
  const body = new URLSearchParams({
    client,
    duration: String(Math.max(1, Math.round(duration))),
    fingerprint,
    meta: "recordings+releasegroups+compress",
    format: "json",
  });
  let response;
  try {
    response = await fetch(ACOUSTID_LOOKUP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new Error(error?.name === "TimeoutError" ? "AcoustID lookup timed out." : "Could not reach AcoustID.");
  }
  if (!response.ok) throw new Error(`AcoustID lookup failed (${response.status}).`);
  const data = await response.json().catch(() => null);
  if (data?.status !== "ok") throw new Error(data?.error?.message || "AcoustID lookup failed.");
  return data.results || [];
}
