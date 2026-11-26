export function createAnimationLoop({ requestFrame, cancelFrame, canRun, onFrame }) {
  let frameId = null;
  let generation = 0;

  function schedule(runGeneration) {
    frameId = requestFrame(() => {
      if (runGeneration !== generation) return;
      frameId = null;
      if (!canRun()) return;
      onFrame();
      if (runGeneration === generation && canRun()) schedule(runGeneration);
    });
  }

  return {
    start() {
      if (frameId !== null || !canRun()) return;
      generation += 1;
      schedule(generation);
    },
    stop() {
      generation += 1;
      if (frameId !== null) cancelFrame(frameId);
      frameId = null;
    },
  };
}

export function normalizeFrequencyLevel(data, firstBin, lastBin) {
  const start = Math.max(0, firstBin);
  const end = Math.min(data.length, lastBin);
  const count = end - start;
  if (count <= 0) return 0.12;
  let energy = 0;
  let peak = 0;
  for (let bin = start; bin < end; bin += 1) {
    const amplitude = data[bin] / 255;
    energy += amplitude * amplitude;
    peak = Math.max(peak, amplitude);
  }
  const rms = Math.sqrt(energy / count);
  const amplitude = Math.max(rms, peak * 0.52);
  const normalized = Math.max(0, Math.min(1, (amplitude - 0.012) / 0.3));
  return 0.12 + normalized ** 0.62 * 0.88;
}
