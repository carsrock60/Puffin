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

export function lookupAcoustID({ client, duration, fingerprint }) {
  return new Promise((resolve, reject) => {
    const callbackName = `puffinAcoustid_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const timeout = window.setTimeout(() => finish(new Error("AcoustID lookup timed out.")), 20000);
    const finish = (error, data) => {
      window.clearTimeout(timeout);
      script.remove();
      delete window[callbackName];
      if (error) reject(error);
      else if (data?.status !== "ok") reject(new Error(data?.error?.message || "AcoustID lookup failed."));
      else resolve(data.results || []);
    };

    window[callbackName] = (data) => finish(null, data);
    script.onerror = () => finish(new Error("Could not reach AcoustID."));
    const params = new URLSearchParams({
      client,
      duration: String(Math.max(1, Math.round(duration))),
      fingerprint,
      meta: "recordings+releasegroups+compress",
      format: "jsonp",
      jsoncallback: callbackName,
    });
    script.src = `https://api.acoustid.org/v2/lookup?${params}`;
    document.head.append(script);
  });
}
