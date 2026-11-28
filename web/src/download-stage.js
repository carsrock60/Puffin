// The on-device downloader reports machine-readable stage names. This module is
// the single place that decides what each one means to a person, so the download
// panel and its tests never drift apart.
const STAGES = {
  preparing: {
    label: "Preparing download",
    detail: "Starting the on-device downloader and making room for the new file…",
  },
  resolving: {
    label: "Resolving media",
    detail: "Asking YouTube for the video, audio, and subtitle formats…",
  },
  downloading: {
    label: "Downloading on this device",
    detail: "Receiving data directly from YouTube…",
  },
  processing: {
    label: "Processing media",
    detail: "Combining video and audio, finishing the container, and fetching subtitles…",
  },
  completed: {
    label: "Download complete",
    detail: "The on-device downloader finished the file.",
  },
  failed: {
    label: "Download failed",
    detail: "The on-device downloader could not finish this download.",
  },
  cancelled: {
    label: "Download cancelled",
    detail: "The on-device downloader stopped and cleaned up its temporary files.",
  },
};

export function describeDownloadStage(job) {
  const status = String(job?.status || "").toLowerCase();
  const stage = STAGES[String(job?.stage || "").toLowerCase()] || null;
  const progress = Number(job?.progress) || 0;

  if (status === "failed") {
    return { label: STAGES.failed.label, detail: job?.error || STAGES.failed.detail };
  }
  if (status === "cancelled") {
    return { label: STAGES.cancelled.label, detail: STAGES.cancelled.detail };
  }
  if (status === "ready") {
    return { label: "Download complete", detail: "Copying the finished file into your Puffin library…" };
  }
  if (status === "queued" && !stage) {
    return { label: "Queued", detail: "Waiting for the on-device downloader to start this download…" };
  }
  if (status === "starting" || status === "preparing") {
    return { label: STAGES.preparing.label, detail: STAGES.preparing.detail };
  }
  if (status === "converting" || stage === STAGES.processing) {
    return { label: STAGES.processing.label, detail: STAGES.processing.detail };
  }
  if (progress > 0) {
    const details = [job?.speed, job?.eta ? `${job.eta} remaining` : ""].filter(Boolean);
    return {
      label: `Downloading on this device · ${Math.round(Math.min(100, progress))}%`,
      detail: details.length ? details.join(" · ") : "Calculating transfer speed and remaining time…",
    };
  }
  if (stage) return { label: stage.label, detail: stage.detail };
  if (job?.stage) return { label: STAGES.downloading.label, detail: `${job.stage}…` };
  return {
    label: STAGES.downloading.label,
    detail: "Waiting for the on-device downloader to report progress…",
  };
}
