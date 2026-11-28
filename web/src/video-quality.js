export const VIDEO_QUALITIES = Object.freeze([240, 360, 480, 720, 1080, 1440, 2160]);

export function videoHeightForSliderValue(value) {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index >= VIDEO_QUALITIES.length) return 720;
  return VIDEO_QUALITIES[index];
}

export function videoHeightLabel(height) {
  const pixels = Number(height);
  return pixels === 2160 ? "4K" : `${pixels}p`;
}

export function videoQualityLabel(value) {
  return videoHeightLabel(videoHeightForSliderValue(value));
}
