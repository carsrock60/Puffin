export function getMediaCapacityState(usedBytes, limitBytes) {
  const safeUsed = Number.isFinite(usedBytes) && usedBytes >= 0 ? usedBytes : 0;
  const safeLimit = Number.isFinite(limitBytes) && limitBytes > 0 ? limitBytes : 0;
  const usagePercent = safeLimit ? (safeUsed / safeLimit) * 100 : 100;

  return {
    usedBytes: safeUsed,
    limitBytes: safeLimit,
    remainingBytes: Math.max(0, safeLimit - safeUsed),
    usagePercent,
    isOverLimit: safeUsed > safeLimit,
    isAtLimit: safeUsed >= safeLimit,
  };
}

export class MediaCapacityError extends Error {
  constructor(message) {
    super(message);
    this.name = "MediaCapacityError";
  }
}

export function assertMediaFits(usedBytes, limitBytes, incomingBytes) {
  if (!Number.isFinite(incomingBytes) || incomingBytes < 0) {
    throw new Error("The media file size is unavailable, so Puffin could not confirm storage capacity.");
  }
  const capacity = getMediaCapacityState(usedBytes, limitBytes);
  if (capacity.isOverLimit || incomingBytes > capacity.remainingBytes) {
    const available = capacity.isOverLimit ? 0 : capacity.remainingBytes;
    throw new MediaCapacityError(`Not enough Puffin media storage. ${formatBytes(available)} is available, but this file needs ${formatBytes(incomingBytes)}. Delete files or raise the limit.`);
  }
  return capacity;
}

export async function guardReadyPiDownload({ fileSize, assertCapacity, cancelDownload }) {
  try {
    await assertCapacity(fileSize);
  } catch (capacityError) {
    try {
      await cancelDownload();
    } catch {
      capacityError.message = `${capacityError.message} The Pi could not confirm cleanup; its temporary copy will expire automatically.`;
    }
    throw capacityError;
  }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unavailable";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
