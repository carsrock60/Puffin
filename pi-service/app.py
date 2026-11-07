"""Private, job-based downloader API for Puffin."""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit


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
SPEED_PATTERN = re.compile(r"\bat\s+([0-9.]+\s*[KMG]?i?B/s)")
ETA_PATTERN = re.compile(r"\bETA\s+(\d{2}:\d{2}(?::\d{2})?)")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
LOGGER = logging.getLogger("puffin-downloader")
AUDIO_MIME_TYPES = {
    "aac": "audio/aac",
    "aiff": "audio/aiff",
    "flac": "audio/flac",
    "m4a": "audio/mp4",
    "mp3": "audio/mpeg",
    "oga": "audio/ogg",
    "ogg": "audio/ogg",
    "opus": "audio/ogg",
    "wav": "audio/wav",
    "webm": "audio/webm",
}
SUPPORTED_AUDIO_EXTENSIONS = set(AUDIO_MIME_TYPES)


class DownloadFailure(Exception):
    """A download or conversion failed for a known, user-actionable reason."""


def _yt_dlp_command(*arguments: str) -> list[str]:
    # Use the exact interpreter running this service. systemd does not
    # activate the virtual environment's bin directory in PATH.
    return [sys.executable, "-m", "yt_dlp", *arguments]


def _signal_process_group(process: subprocess.Popen, force: bool = False) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        try:
            process.kill() if force else process.terminate()
        except ProcessLookupError:
            pass


def _terminate_process_group(process: subprocess.Popen) -> None:
    _signal_process_group(process)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        _signal_process_group(process, force=True)
        process.wait()


def _safe_diagnostic(line: str) -> str:
    line = re.sub(r"https?://\S+", "[URL]", line)
    return " ".join(line.split())[:240]


def _yt_dlp_failure_message(lines: list[str], return_code: int) -> str:
    output = "\n".join(lines)
    lowered = output.lower()
    if "no module named yt_dlp" in lowered:
        return "yt-dlp is missing from the service virtual environment. Run pip install -r requirements.txt and restart the Pi service."
    if "requested format is not available" in lowered:
        return "This video does not offer an H.264 video stream with AAC audio."
    if any(term in lowered for term in ("javascript runtime", "javascript challenge", "yt-dlp-ejs", "[jsc]")):
        return "YouTube could not run its JavaScript challenge solver. Install Deno and update the Pi service requirements, then restart the service."
    if "http error 429" in lowered or "too many requests" in lowered:
        return "YouTube temporarily rate-limited the Pi. Wait a little and retry."
    if "sign in to confirm" in lowered or "private video" in lowered or "requires authentication" in lowered:
        return "This video requires sign-in or is not publicly available."

    for line in reversed(lines):
        if "error:" in line.lower():
            return f"yt-dlp failed: {_safe_diagnostic(line)}"
    return f"yt-dlp exited with code {return_code}. Check the Pi service logs for details."


def _is_allowed_media_url(value: object) -> bool:
    if not isinstance(value, str) or len(value) > 4096:
        return False
    if value.startswith(("ytsearch:", "ytsearch1:")):
        query = value.split(":", 1)[1].strip()
        return bool(query) and len(query) <= 1000 and not any(ord(character) < 32 for character in query)
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


def _ensure_supported_audio(path: Path, supported_formats: list[str], job: dict) -> Path:
    extension = path.suffix.lower().lstrip(".")
    if extension in supported_formats and extension in SUPPORTED_AUDIO_EXTENSIONS:
        return path

    output_path = path.with_suffix(".m4a")
    with JOBS_LOCK:
        job["status"] = "converting"
        job["progress"] = 99
        job["updated_at"] = time.time()

    common_args = ["ffmpeg", "-nostdin", "-y", "-i", str(path), "-vn"]
    copied = subprocess.run(
        [*common_args, "-c:a", "copy", "-movflags", "+faststart", str(output_path)],
        capture_output=True,
        text=True,
    )
    if copied.returncode != 0:
        encoded = subprocess.run(
            [*common_args, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(output_path)],
            capture_output=True,
            text=True,
        )
        if encoded.returncode != 0:
            detail = (encoded.stderr or copied.stderr or "").strip().splitlines()
            summary = _safe_diagnostic(detail[-1]) if detail else "ffmpeg returned an error"
            raise DownloadFailure(f"Could not convert this audio to a Puffin-compatible M4A file: {summary}")

    path.unlink(missing_ok=True)
    return output_path


def _ensure_video_output(path: Path) -> None:
    if path.suffix.lower() != ".mp4":
        raise DownloadFailure("The Pi did not produce an MP4 video. Choose a source with H.264 video and AAC audio, then retry.")

    probe = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(path),
        ],
        capture_output=True,
        text=True,
        timeout=20,
    )
    if probe.returncode != 0 or probe.stdout.strip() != "video":
        raise DownloadFailure("The Pi download contains no video stream. Choose a video result and retry.")


def _public_job(job: dict) -> dict:
    return {
        "id": job["id"],
        "status": job["status"],
        "progress": job["progress"],
        "speed": job.get("speed"),
        "eta": job.get("eta"),
        "kind": job["kind"],
        "filename": job.get("filename"),
        "size": job.get("size"),
        "mime_type": job.get("mime_type"),
        "error": job.get("error"),
    }


def _search_youtube(query: str) -> list[dict]:
    command = _yt_dlp_command(
        "--dump-single-json",
        "--flat-playlist",
        "--skip-download",
        "--no-progress",
        "--no-warnings",
        f"ytsearch10:{query}",
    )
    result = subprocess.run(command, capture_output=True, text=True, timeout=30, check=True)
    payload = json.loads(result.stdout)
    videos = []
    for entry in payload.get("entries") or []:
        video_id = entry.get("id")
        if not video_id:
            continue
        thumbnails = entry.get("thumbnails") or []
        thumbnail = entry.get("thumbnail") or (thumbnails[-1].get("url") if thumbnails else None)
        videos.append({
            "id": video_id,
            "url": f"https://www.youtube.com/watch?v={quote(str(video_id), safe='')}",
            "title": entry.get("title") or "Untitled video",
            "channel": entry.get("uploader") or entry.get("channel") or "Unknown channel",
            "duration": entry.get("duration"),
            "thumbnail": thumbnail,
        })
        if len(videos) == 10:
            break
    return videos


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
            job["worker_active"] = False
            job["updated_at"] = time.time()
            _remove_work_directory(job)
            return
        job["status"] = "downloading"
        job["updated_at"] = time.time()

    work_dir = Path(job["work_dir"])
    output_template = str(work_dir / "%(title).160s [%(id)s].%(ext)s")
    command = _yt_dlp_command(
        "--no-playlist",
        "--newline",
        "--progress",
        "--no-write-info-json",
        "--no-write-thumbnail",
        "--no-write-subs",
        "--no-overwrites",
        "--retry-sleep",
        "http:linear=1:5",
        "--retry-sleep",
        "fragment:linear=1:5",
        "--retry-sleep",
        "extractor:linear=1:3",
        "--max-filesize",
        str(MAX_DOWNLOAD_BYTES),
        "--output",
        output_template,
    )

    if job["kind"] == "audio":
        command.extend([
            "--format",
            "bestaudio",
        ])
    else:
        command.extend([
            "--format",
            "bv[vcodec~='^(avc|h264)']+ba[acodec~='^(mp4a|aac)']/b[vcodec~='^(avc|h264)'][acodec~='^(mp4a|aac)']",
            "--merge-output-format",
            "mp4",
        ])
    command.append(job["url"])

    process = None
    compatible_format_missing = False
    output_tail = []
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            bufsize=1,
            start_new_session=True,
        )
        with JOBS_LOCK:
            current_job = JOBS.get(job_id)
            if not current_job:
                _signal_process_group(process)
                return
            current_job["process"] = process
            if current_job["cancel_requested"]:
                _signal_process_group(process)

        for line in process.stdout or []:
            output_tail.append(line.strip())
            if len(output_tail) > 40:
                del output_tail[0]
            if "Requested format is not available" in line:
                compatible_format_missing = True
            with JOBS_LOCK:
                current_job = JOBS.get(job_id)
                if not current_job:
                    _signal_process_group(process)
                    break
                if current_job["cancel_requested"]:
                    _signal_process_group(process)
                    break
                if "[Merger]" in line or ("[ExtractAudio]" in line and "Not converting audio" not in line):
                    current_job["status"] = "converting"
                    current_job["updated_at"] = time.time()
                match = PROGRESS_PATTERN.search(line)
                if match:
                    current_job["status"] = "downloading"
                    current_job["progress"] = min(99, max(0, float(match.group(1))))
                    current_job["updated_at"] = time.time()
                speed_match = SPEED_PATTERN.search(line)
                eta_match = ETA_PATTERN.search(line)
                if speed_match:
                    current_job["speed"] = speed_match.group(1)
                if eta_match:
                    current_job["eta"] = eta_match.group(1)

        return_code = process.wait()
        with JOBS_LOCK:
            current_job = JOBS.get(job_id)
            if not current_job:
                _remove_work_directory(job)
                return
            current_job["process"] = None
            if current_job["cancel_requested"]:
                current_job["status"] = "cancelled"
                current_job["worker_active"] = False
                current_job["updated_at"] = time.time()
                _remove_work_directory(current_job)
                return

        if return_code != 0:
            if compatible_format_missing:
                raise DownloadFailure("This video does not offer an H.264 video stream with AAC audio.")
            raise DownloadFailure(_yt_dlp_failure_message(output_tail, return_code))

        output_files = [
            path for path in work_dir.iterdir()
            if path.is_file() and not path.name.endswith((".part", ".ytdl", ".json", ".jpg", ".webp"))
        ]
        if not output_files:
            raise DownloadFailure("yt-dlp finished but did not create a media file. Check the Pi service logs for details.")

        output_file = max(output_files, key=lambda path: path.stat().st_mtime)
        if job["kind"] == "audio":
            output_file = _ensure_supported_audio(output_file, job.get("supported_audio_formats") or [], job)
        else:
            _ensure_video_output(output_file)
        with JOBS_LOCK:
            current_job = JOBS.get(job_id)
            if not current_job:
                _remove_work_directory(job)
                return
            if current_job["cancel_requested"]:
                current_job["status"] = "cancelled"
                current_job["worker_active"] = False
                current_job["updated_at"] = time.time()
                _remove_work_directory(current_job)
                return
        output_size = output_file.stat().st_size
        if output_size > MAX_DOWNLOAD_BYTES:
            raise DownloadFailure("The download exceeded the configured file size limit.")

        with JOBS_LOCK:
            current_job = JOBS.get(job_id)
            if not current_job:
                _remove_work_directory(job)
                return
            if current_job["cancel_requested"]:
                current_job["status"] = "cancelled"
                current_job["worker_active"] = False
                current_job["updated_at"] = time.time()
                _remove_work_directory(current_job)
                return
            current_job.update({
                "status": "ready",
                "worker_active": False,
                "progress": 100,
                "filename": _safe_filename(output_file),
                "file_path": str(output_file),
                "size": output_size,
                "mime_type": AUDIO_MIME_TYPES.get(output_file.suffix.lower().lstrip(".")) if job["kind"] == "audio" else (mimetypes.guess_type(output_file.name)[0] or "application/octet-stream"),
                "ready_at": time.time(),
                "updated_at": time.time(),
            })
        LOGGER.info("Download job %s is ready (%s bytes)", job_id, output_size)
    except FileNotFoundError as error:
        if process and process.poll() is None:
            _terminate_process_group(process)
        message = "A required Pi tool or media file is missing. Check that Deno and ffmpeg are installed and retry."
        _fail_job(job_id, message)
        LOGGER.warning("Download job %s failed (%s): %s", job_id, type(error).__name__, message)
    except Exception as error:
        if process and process.poll() is None:
            _terminate_process_group(process)
        message = str(error) if isinstance(error, DownloadFailure) else "The download failed unexpectedly. Check the Pi service logs for details."
        message = _safe_diagnostic(message)
        _fail_job(job_id, message)
        LOGGER.warning("Download job %s failed (%s): %s", job_id, type(error).__name__, message)


def _fail_job(job_id: str, message: str) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        job["process"] = None
        job["worker_active"] = False
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
        parsed_path = urlsplit(self.path)
        path_parts = [unquote(part) for part in parsed_path.path.strip("/").split("/")]

        if path_parts == ["api", "health"]:
            self._json(200, {"ok": True, "service": "puffin-downloader"})
            return

        if path_parts == ["api", "search"]:
            query = parse_qs(parsed_path.query).get("q", [""])[0].strip()
            if not query or len(query) > 200:
                self._json(400, {"error": "Enter a YouTube search between 1 and 200 characters."})
                return
            try:
                videos = _search_youtube(query)
            except subprocess.TimeoutExpired:
                self._json(504, {"error": "YouTube search timed out. Try again in a moment."})
                return
            except Exception as error:
                LOGGER.warning("YouTube search failed: %s", type(error).__name__)
                self._json(502, {"error": "YouTube search failed. Check the Pi connection and try again."})
                return
            self._json(200, {"videos": videos})
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
            self._json(400, {"error": "Enter an HTTPS YouTube video URL or a valid YouTube search query."})
            return
        if not isinstance(kind, str) or kind not in {"audio", "video"}:
            self._json(400, {"error": "Choose audio (M4A) or video (MP4)."})
            return
        requested_audio_formats = request.get("supported_audio_formats", [])
        if not isinstance(requested_audio_formats, list):
            requested_audio_formats = []
        supported_audio_formats = [
            extension.lower()
            for extension in requested_audio_formats
            if isinstance(extension, str) and extension.lower() in SUPPORTED_AUDIO_EXTENSIONS
        ]

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
                "supported_audio_formats": supported_audio_formats,
                "status": "queued",
                "progress": 0,
                "speed": None,
                "eta": None,
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
                "worker_active": True,
                "transfers": 0,
            }
            JOBS[job_id] = job

        try:
            threading.Thread(target=_run_download, args=(job_id,), daemon=True).start()
        except RuntimeError as error:
            _fail_job(job_id, "The Pi could not start a download worker. Restart the downloader service and try again.")
            LOGGER.error("Could not start download job %s worker: %s", job_id, type(error).__name__)
            self._json(503, {"error": "The Pi is busy and could not start a download. Try again shortly."})
            return
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
                _signal_process_group(process)
            if job["status"] == "ready":
                _remove_work_directory(job)
                del JOBS[job_id]
            elif job.get("worker_active"):
                # Let the worker clean up its directory once it has stopped
                # using it; removing it here races with post-download checks.
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
