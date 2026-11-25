// The Pi reports machine-readable stage names. This module is the single
// place that decides what each one means to a person, so the download panel
// and its tests never drift apart.
const STAGES = {
  preparing: {
    label: "Preparing download",
    detail: "Checking the Pi and making room for the new file…",
  },
  resolving: {
    label: "Resolving media on the Pi",
    detail: "Asking YouTube for the video, audio, and subtitle formats…",
  },
  downloading: {
    label: "Downloading on the Pi",
    detail: "Receiving data from YouTube…",
  },
  processing: {
    label: "Processing on the Pi",
    detail: "Combining video and audio, converting the container, and fetching subtitles…",
  },
  completed: {
    label: "Download complete",
    detail: "The Pi finished the file.",
  },
  failed: {
    label: "Download failed",
    detail: "The Pi could not finish this download.",
  },
  cancelled: {
    label: "Download cancelled",
    detail: "The Pi stopped the download and cleaned up its temporary files.",
  },
};

export function describeDownloadStage(job) {
  const status = job?.status;
  const stage = STAGES[String(job?.stage || "").toLowerCase()] || null;
  const progress = Number(job?.progress) || 0;

  if (status === "failed") {
    return { label: STAGES.failed.label, detail: job?.error || STAGES.failed.detail };
  }
  if (status === "cancelled") {
    return { label: STAGES.cancelled.label, detail: STAGES.cancelled.detail };
  }
  if (status === "ready") {
    return { label: "Download complete on the Pi", detail: "Receiving the finished file from the Pi…" };
  }
  if (status === "queued" && !stage) {
    return { label: "Queued on the Pi", detail: "Waiting for the Pi to start this download…" };
  }
  if (status === "converting" || stage === STAGES.processing) {
    return { label: STAGES.processing.label, detail: STAGES.processing.detail };
  }
  if (progress > 0) {
    const details = [job?.speed, job?.eta ? `${job.eta} remaining` : ""].filter(Boolean);
    return {
      label: `Downloading on the Pi · ${Math.round(Math.min(100, progress))}%`,
      detail: details.length ? details.join(" · ") : "Calculating transfer speed and remaining time…",
    };
  }
  if (stage) return { label: stage.label, detail: stage.detail };
  // Pi services from before named stages send free text such as
  // "Contacting YouTube"; keep showing it rather than inventing a stage.
  if (job?.stage) return { label: STAGES.downloading.label, detail: `${job.stage}…` };
  return {
    label: STAGES.downloading.label,
    detail: "Waiting for the Pi to report progress…",
  };
}
