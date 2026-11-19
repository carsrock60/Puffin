export const VIDEO_QUALITIES = Object.freeze([240, 360, 480, 720, 1080, 1440, 2160]);

export function videoHeightForSliderValue(value) {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index >= VIDEO_QUALITIES.length) return 720;
  return VIDEO_QUALITIES[index];
}

export function videoQualityLabel(value) {
  const height = videoHeightForSliderValue(value);
  return height === 2160 ? "4K" : `${height}p`;
}

export function piSupportsVideoQuality(health, height) {
  return Array.isArray(health?.video_quality_options) && health.video_quality_options.includes(height);
}
