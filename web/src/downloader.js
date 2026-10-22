import { saveMediaFile } from "./library.js";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function getPiBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("Enter the Pi's HTTPS address from Tailscale Serve.");
  }

  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error("Use the Pi's HTTPS Tailscale address, for example https://pi-name.tailnet.ts.net.");
  }

  return parsed.origin;
}

async function responsePayload(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function requestJson(baseUrl, endpoint, options) {
  const response = await fetch(`${baseUrl}${endpoint}`, options);
  const payload = await responsePayload(response);
  if (!response.ok) throw new Error(payload.error || `Pi request failed (${response.status}).`);
  return payload;
}

function setStatus(element, message) {
  element.textContent = message;
}

async function checkPi(baseUrl) {
  const health = await requestJson(baseUrl, "/api/health");
  if (!health.ok) throw new Error("The Pi service did not return a healthy status.");
}

async function confirmPiSavedFile(baseUrl, jobId) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/downloads/${jobId}/complete`, { method: "POST" });
    if (response.ok) return true;

    const payload = await responsePayload(response);
    if (response.status !== 409) {
      throw new Error(payload.error || `Pi cleanup confirmation failed (${response.status}).`);
    }
    await sleep(250);
  }
  return false;
}

export function initializeDownloader() {
  const form = document.querySelector("#download-form");
  const piAddress = document.querySelector("#pi-address");
  const youtubeUrl = document.querySelector("#youtube-url");
  const downloadKind = document.querySelector("#download-kind");
  const checkButton = document.querySelector("#check-pi");
  const submitButton = document.querySelector("#start-download");
  const progress = document.querySelector("#download-progress");
  const status = document.querySelector("#download-status");

  try {
    piAddress.value = localStorage.getItem("puffin-pi-address") || "";
  } catch {
    // The address can still be entered and used if local storage is unavailable.
  }

  piAddress.addEventListener("change", () => {
    try {
      localStorage.setItem("puffin-pi-address", piAddress.value.trim());
    } catch {
      // Saving the address is optional; it can be re-entered next time.
    }
  });

  checkButton.addEventListener("click", async () => {
    checkButton.disabled = true;
    try {
      const baseUrl = getPiBaseUrl(piAddress.value);
      setStatus(status, "Checking Pi connection…");
      await checkPi(baseUrl);
      setStatus(status, "Pi is connected and ready.");
    } catch (error) {
      setStatus(status, error.message);
    } finally {
      checkButton.disabled = false;
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submitButton.disabled = true;
    checkButton.disabled = true;
    progress.hidden = false;
    progress.value = 0;

    let baseUrl;
    let jobId;
    let savedLocally = false;
    let transferStarted = false;

    try {
      baseUrl = getPiBaseUrl(piAddress.value);
      try {
        localStorage.setItem("puffin-pi-address", baseUrl);
      } catch {
        // Saving the address is optional; the current download can proceed.
      }
      setStatus(status, "Connecting to the Pi…");
      await checkPi(baseUrl);

      const job = await requestJson(baseUrl, "/api/downloads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: youtubeUrl.value.trim(), kind: downloadKind.value }),
      });
      jobId = job.id;

      let currentJob = job;
      while (["queued", "downloading", "converting"].includes(currentJob.status)) {
        progress.value = currentJob.progress || 0;
        if (currentJob.status === "queued") setStatus(status, "Pi download queued…");
        else if (currentJob.status === "converting") setStatus(status, "Converting media on the Pi…");
        else if (currentJob.progress) setStatus(status, `Downloading on the Pi · ${Math.round(currentJob.progress)}%`);
        else setStatus(status, "Downloading on the Pi…");

        await sleep(1200);
        currentJob = await requestJson(baseUrl, `/api/downloads/${jobId}`);
      }

      if (currentJob.status !== "ready") {
        throw new Error(currentJob.error || "The Pi download did not finish.");
      }

      progress.value = 100;
      setStatus(status, "Receiving file from the Pi…");
      transferStarted = true;
      const fileResponse = await fetch(`${baseUrl}/api/downloads/${jobId}/file`);
      if (!fileResponse.ok) {
        const payload = await responsePayload(fileResponse);
        throw new Error(payload.error || `File transfer failed (${fileResponse.status}).`);
      }

      const mediaBlob = await fileResponse.blob();
      setStatus(status, "Saving to this device…");
      const encodedName = fileResponse.headers.get("X-Download-Name");
      let filename = `puffin-download.${downloadKind.value === "audio" ? "m4a" : "mp4"}`;
      if (encodedName) {
        try {
          filename = decodeURIComponent(encodedName);
        } catch {
          filename = encodedName;
        }
      } else if (currentJob.filename) {
        filename = currentJob.filename;
      }

      try {
        if (navigator.storage?.persist) await navigator.storage.persist();
      } catch {
        // IndexedDB can still save the file when persistent storage is unavailable.
      }
      await saveMediaFile(mediaBlob, { name: filename, type: currentJob.mime_type || mediaBlob.type });
      savedLocally = true;
      window.dispatchEvent(new Event("puffin:library-updated"));

      try {
        const cleanedUp = await confirmPiSavedFile(baseUrl, jobId);
        if (cleanedUp) setStatus(status, "Saved to your Puffin library on this device.");
        else setStatus(status, "Saved locally. The Pi will remove its temporary copy after it expires.");
      } catch {
        setStatus(status, "Saved locally. The Pi could not confirm cleanup; its temporary copy will expire automatically.");
      }
    } catch (error) {
      setStatus(status, error.message || "The download failed.");
      if (jobId && baseUrl && !savedLocally) {
        // Keep a completed file on the Pi if transfer or local storage failed.
        // The Pi expires unconfirmed files automatically after its retention period.
        if (transferStarted) {
          setStatus(status, `${error.message || "The transfer failed."} The Pi will keep its temporary copy for up to one hour.`);
        } else {
          fetch(`${baseUrl}/api/downloads/${jobId}`, { method: "DELETE" }).catch(() => {});
        }
      }
    } finally {
      submitButton.disabled = false;
      checkButton.disabled = false;
      progress.hidden = true;
    }
  });
}
