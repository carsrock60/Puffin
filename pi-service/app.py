"""Private, job-based downloader API for Puffin."""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit


HOST = "127.0.0.1"
PORT = int(os.environ.get("PUFFIN_PORT", "8765"))
DOWNLOAD_DIR = Path(os.environ.get("PUFFIN_DOWNLOAD_DIR", "~/puffin-downloads")).expanduser()
MAX_DOWNLOAD_BYTES = int(os.environ.get("PUFFIN_MAX_DOWNLOAD_BYTES", str(2 * 1024**3)))
MIN_FREE_BYTES = int(os.environ.get("PUFFIN_MIN_FREE_BYTES", str(1024**3)))
JOB_RETENTION_SECONDS = int(os.environ.get("PUFFIN_JOB_RETENTION_SECONDS", "3600"))
ALLOWED_ORIGINS = {
    origin.strip().rstrip("/")
    for origin in os.environ.get("PUFFIN_ALLOWED_ORIGINS", "http://localhost:5173").split(",")
    if origin.strip()
}

JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.RLock()
PROGRESS_PATTERN = re.compile(r"\[download\]\s+(\d+(?:\.\d+)?)%")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
LOGGER = logging.getLogger("puffin-downloader")


def _is_allowed_media_url(value: object) -> bool:
    if not isinstance(value, str) or len(value) > 4096:
        return False
    try:
        parsed = urlsplit(value)
        hostname = (parsed.hostname or "").lower().rstrip(".")
        port = parsed.port
    except ValueError:
        return False

    youtube_host = hostname == "youtu.be" or hostname == "youtube.com" or hostname.endswith(".youtube.com")
    return parsed.scheme == "https" and port in {None, 443} and not parsed.username and not parsed.password and youtube_host


def _safe_filename(path: Path) -> str:
    name = path.name.replace("\r", "").replace("\n", "").replace('"', "'")
    return name or "puffin-media"


def _public_job(job: dict) -> dict:
    return {
        "id": job["id"],
        "status": job["status"],
        "progress": job["progress"],
        "kind": job["kind"],
        "filename": job.get("filename"),
        "size": job.get("size"),
        "mime_type": job.get("mime_type"),
        "error": job.get("error"),
    }


def _remove_work_directory(job: dict) -> None:
    work_dir = job.get("work_dir")
    if work_dir:
        shutil.rmtree(work_dir, ignore_errors=True)


def _run_download(job_id: str) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        if job["cancel_requested"]:
            job["status"] = "cancelled"
            job["updated_at"] = time.time()
            return
        job["status"] = "downloading"
        job["updated_at"] = time.time()

    work_dir = Path(job["work_dir"])
    output_template = str(work_dir / "%(title).160s [%(id)s].%(ext)s")
    command = [
        "yt-dlp",
        "--no-playlist",
        "--newline",
        "--progress",
        "--no-write-info-json",
        "--no-write-thumbnail",
        "--no-write-subs",
        "--no-overwrites",
        "--max-filesize",
        str(MAX_DOWNLOAD_BYTES),
        "--output",
        output_template,
    ]

    if job["kind"] == "audio":
        command.extend(["--format", "bestaudio/best", "--extract-audio", "--audio-format", "m4a", "--audio-quality", "5"])
    else:
        command.extend([
            "--format",
            "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
            "--merge-output-format",
            "mp4",
        ])
    command.append(job["url"])

    process = None
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            bufsize=1,
        )
        with JOBS_LOCK:
            current_job = JOBS.get(job_id)
            if not current_job:
                process.terminate()
                return
            current_job["process"] = process
            if current_job["cancel_requested"]:
                process.terminate()

        for line in process.stdout or []:
            with JOBS_LOCK:
                current_job = JOBS.get(job_id)
                if not current_job:
                    process.terminate()
                    break
                if current_job["cancel_requested"]:
                    process.terminate()
                    break
                if "[ExtractAudio]" in line or "[Merger]" in line:
                    current_job["status"] = "converting"
                    current_job["updated_at"] = time.time()
                match = PROGRESS_PATTERN.search(line)
                if match:
                    current_job["status"] = "downloading"
                    current_job["progress"] = min(99, max(0, float(match.group(1))))
                    current_job["updated_at"] = time.time()

        return_code = process.wait()
        with JOBS_LOCK:
            current_job = JOBS.get(job_id)
            if not current_job:
                _remove_work_directory(job)
                return
            current_job["process"] = None
            if current_job["cancel_requested"]:
                current_job["status"] = "cancelled"
                current_job["updated_at"] = time.time()
                _remove_work_directory(current_job)
                return

        if return_code != 0:
            raise RuntimeError(f"yt-dlp exited with code {return_code}")

        output_files = [
            path for path in work_dir.iterdir()
            if path.is_file() and not path.name.endswith((".part", ".ytdl", ".json", ".jpg", ".webp"))
        ]
        if not output_files:
            raise RuntimeError("yt-dlp completed without producing a media file")

        output_file = max(output_files, key=lambda path: path.stat().st_mtime)
        output_size = output_file.stat().st_size
        if output_size > MAX_DOWNLOAD_BYTES:
            raise RuntimeError("Downloaded file exceeds the configured size limit")

        with JOBS_LOCK:
            current_job = JOBS.get(job_id)
            if not current_job:
                _remove_work_directory(job)
                return
            current_job.update({
                "status": "ready",
                "progress": 100,
                "filename": _safe_filename(output_file),
                "file_path": str(output_file),
                "size": output_size,
                "mime_type": mimetypes.guess_type(output_file.name)[0] or "application/octet-stream",
                "ready_at": time.time(),
                "updated_at": time.time(),
            })
        LOGGER.info("Download job %s is ready (%s bytes)", job_id, output_size)
    except FileNotFoundError:
        _fail_job(job_id, "yt-dlp is not installed on the Pi. Install the service requirements and restart it.")
    except Exception as error:  # Keep subprocess details out of API responses and logs.
        _fail_job(job_id, "The download failed. Check the link, available formats, and Pi service logs.")
        LOGGER.warning("Download job %s failed: %s", job_id, type(error).__name__)


def _fail_job(job_id: str, message: str) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        job["process"] = None
        job["status"] = "failed"
        job["error"] = message
        job["updated_at"] = time.time()
        _remove_work_directory(job)


def _cleanup_expired_jobs() -> None:
    while True:
        time.sleep(60)
        now = time.time()
        with JOBS_LOCK:
            expired = [
                job_id for job_id, job in JOBS.items()
                if job["status"] in {"ready", "failed", "cancelled"}
                and not job["transfers"]
                and now - (job.get("ready_at") or job["updated_at"]) > JOB_RETENTION_SECONDS
            ]
            for job_id in expired:
                _remove_work_directory(JOBS.pop(job_id))


class PuffinHandler(BaseHTTPRequestHandler):
    server_version = "PuffinDownloader/1.0"

    def log_message(self, format_string: str, *args) -> None:
        # Avoid logging full request paths, which may contain private video URLs.
        LOGGER.info("%s %s", self.command, self.path.split("?", 1)[0])

    def _origin(self) -> str | None:
        origin = self.headers.get("Origin")
        if origin is None:
            return None
        return origin.rstrip("/")

    def _origin_allowed(self) -> bool:
        origin = self._origin()
        return origin is None or origin in ALLOWED_ORIGINS

    def _cors_headers(self) -> None:
        origin = self._origin()
        if origin and origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Expose-Headers", "Content-Length, X-Download-Name")

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _no_content(self, status: int = 204) -> None:
        self.send_response(status)
        self._cors_headers()
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _reject_origin(self) -> bool:
        if self._origin_allowed():
            return False
        self._json(403, {"error": "This Puffin website origin is not allowed by the Pi service."})
        return True

    def _read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Invalid Content-Length header.") from error
        if length <= 0 or length > 16_384:
            raise ValueError("Request body must be between 1 byte and 16 KB.")
        try:
            value = json.loads(self.rfile.read(length))
        except json.JSONDecodeError as error:
            raise ValueError("Request body must be valid JSON.") from error
        if not isinstance(value, dict):
            raise ValueError("Request body must be a JSON object.")
        return value

    def do_OPTIONS(self) -> None:
        if self._reject_origin():
            return
        self.send_response(204)
        self._cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self) -> None:
        if self._reject_origin():
            return
        path_parts = [unquote(part) for part in urlsplit(self.path).path.strip("/").split("/")]

        if path_parts == ["api", "health"]:
            self._json(200, {"ok": True, "service": "puffin-downloader"})
            return

        if len(path_parts) == 3 and path_parts[:2] == ["api", "downloads"]:
            with JOBS_LOCK:
                job = JOBS.get(path_parts[2])
                response = _public_job(job) if job else None
            if response is None:
                self._json(404, {"error": "Download job not found or expired."})
            else:
                self._json(200, response)
            return

        if len(path_parts) == 4 and path_parts[:2] == ["api", "downloads"] and path_parts[3] == "file":
            self._send_job_file(path_parts[2])
            return

        self._json(404, {"error": "Endpoint not found."})

    def _send_job_file(self, job_id: str) -> None:
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if not job or job["status"] != "ready":
                self._json(409, {"error": "The download is not ready."})
                return
            file_path = Path(job["file_path"])
            filename = job["filename"]
            mime_type = job["mime_type"]
            size = job["size"]
            job["transfers"] += 1

        try:
            media_file = file_path.open("rb")
            self.send_response(200)
            self._cors_headers()
            self.send_header("Content-Type", mime_type)
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(filename)}")
            self.send_header("X-Download-Name", quote(filename, safe=""))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

            with media_file:
                while True:
                    chunk = media_file.read(256 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except FileNotFoundError:
            self._json(410, {"error": "The temporary download file has expired."})
        except (BrokenPipeError, ConnectionResetError):
            LOGGER.info("File transfer for job %s was interrupted; keeping the temporary file for retry.", job_id)
        finally:
            with JOBS_LOCK:
                current_job = JOBS.get(job_id)
                if current_job:
                    current_job["transfers"] = max(0, current_job["transfers"] - 1)

    def do_POST(self) -> None:
        if self._reject_origin():
            return
        path_parts = [unquote(part) for part in urlsplit(self.path).path.strip("/").split("/")]

        if path_parts == ["api", "downloads"]:
            self._create_download()
            return

        if len(path_parts) == 4 and path_parts[:2] == ["api", "downloads"] and path_parts[3] == "complete":
            self._complete_download(path_parts[2])
            return

        self._json(404, {"error": "Endpoint not found."})

    def _create_download(self) -> None:
        try:
            request = self._read_json()
        except ValueError as error:
            self._json(400, {"error": str(error)})
            return

        url = request.get("url")
        kind = request.get("kind")
        if not _is_allowed_media_url(url):
            self._json(400, {"error": "Enter an HTTPS YouTube video URL."})
            return
        if not isinstance(kind, str) or kind not in {"audio", "video"}:
            self._json(400, {"error": "Choose audio (M4A) or video (MP4)."})
            return

        DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
        with JOBS_LOCK:
            existing_job = next((
                job for job in JOBS.values()
                if job["status"] in {"queued", "downloading", "converting"}
                or (job["status"] == "ready" and job["transfers"])
            ), None)
            if existing_job:
                self._json(409, {"error": "Finish or cancel the current Pi download before starting another."})
                return

            # A completed but unconfirmed file is replaceable when another
            # download is requested; the original client's local save failed
            # or it never returned to confirm receipt.
            for old_job_id, old_job in list(JOBS.items()):
                if old_job["status"] == "ready" and not old_job["transfers"]:
                    _remove_work_directory(old_job)
                    del JOBS[old_job_id]

            free_bytes = shutil.disk_usage(DOWNLOAD_DIR).free
            if free_bytes < MIN_FREE_BYTES:
                self._json(507, {"error": "The Pi is low on free storage. Clear space before downloading."})
                return

            job_id = uuid.uuid4().hex
            work_dir = DOWNLOAD_DIR / job_id
            work_dir.mkdir(mode=0o700)
            job = {
                "id": job_id,
                "url": url,
                "kind": kind,
                "status": "queued",
                "progress": 0,
                "error": None,
                "filename": None,
                "file_path": None,
                "size": None,
                "mime_type": None,
                "work_dir": str(work_dir),
                "created_at": time.time(),
                "updated_at": time.time(),
                "ready_at": None,
                "process": None,
                "cancel_requested": False,
                "transfers": 0,
            }
            JOBS[job_id] = job

        threading.Thread(target=_run_download, args=(job_id,), daemon=True).start()
        self._json(202, _public_job(job))

    def _complete_download(self, job_id: str) -> None:
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if not job:
                self._json(404, {"error": "Download job not found or expired."})
                return
            if job["status"] != "ready":
                self._json(409, {"error": "Only a ready download can be confirmed."})
                return
            if job["transfers"]:
                self._json(409, {"error": "Wait for the file transfer to finish before confirming it."})
                return
            _remove_work_directory(job)
            del JOBS[job_id]

        LOGGER.info("Puffin confirmed and removed download job %s", job_id)
        self._no_content()

    def do_DELETE(self) -> None:
        if self._reject_origin():
            return
        path_parts = [unquote(part) for part in urlsplit(self.path).path.strip("/").split("/")]
        if len(path_parts) != 3 or path_parts[:2] != ["api", "downloads"]:
            self._json(404, {"error": "Endpoint not found."})
            return

        job_id = path_parts[2]
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if not job:
                self._json(404, {"error": "Download job not found or expired."})
                return
            if job["transfers"]:
                self._json(409, {"error": "Wait for the current file transfer to finish before cancelling."})
                return
            job["cancel_requested"] = True
            process = job.get("process")
            if process and process.poll() is None:
                process.terminate()
            if job["status"] == "ready":
                _remove_work_directory(job)
                del JOBS[job_id]
            elif process and process.poll() is None:
                # Keep the job active until yt-dlp exits so another job cannot overlap it.
                pass
            else:
                job["status"] = "cancelled"
                job["updated_at"] = time.time()
                _remove_work_directory(job)

        self._no_content(202)


def _remove_stale_files() -> None:
    """Clear abandoned Puffin job folders without touching unrelated files."""
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    for path in DOWNLOAD_DIR.iterdir():
        if path.is_dir() and re.fullmatch(r"[0-9a-f]{32}", path.name):
            shutil.rmtree(path, ignore_errors=True)


def main() -> None:
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    _remove_stale_files()
    threading.Thread(target=_cleanup_expired_jobs, daemon=True).start()

    server = ThreadingHTTPServer((HOST, PORT), PuffinHandler)
    LOGGER.info("Puffin downloader listening on %s:%s", HOST, PORT)
    LOGGER.info("Allowing browser origins: %s", ", ".join(sorted(ALLOWED_ORIGINS)) or "none")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOGGER.info("Stopping Puffin downloader")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
