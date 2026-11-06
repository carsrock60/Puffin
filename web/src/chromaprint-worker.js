import { fingerprintFromSamples } from "rusty-chromaprint-wasm";

self.addEventListener("message", (event) => {
  const { id, sampleRate, channels } = event.data;
  try {
    const channelData = channels.map((buffer) => new Float32Array(buffer));
    const channelCount = channelData.length;
    const frameCount = channelData[0]?.length || 0;
    const samples = new Int16Array(frameCount * channelCount);
    for (let frame = 0; frame < frameCount; frame += 1) {
      for (let channel = 0; channel < channelCount; channel += 1) {
        const sample = Math.max(-1, Math.min(1, channelData[channel][frame]));
        samples[frame * channelCount + channel] = Math.round(sample * 32767);
      }
    }
    const result = fingerprintFromSamples(sampleRate, channelCount, samples);
    self.postMessage({ id, fingerprint: result.compressed });
    result.free?.();
  } catch (error) {
    self.postMessage({ id, error: error?.message || "Could not fingerprint this audio file." });
  }
});
